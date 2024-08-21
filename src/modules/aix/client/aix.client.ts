import type { ChatStreamingInputSchema } from '~/modules/llms/server/llm.server.streaming';
import { findServiceAccessOrThrow } from '~/modules/llms/vendors/vendor.helpers';

import type { DLLMId } from '~/common/stores/llms/llms.types';
import type { DMessage, DMessageGenerator } from '~/common/stores/chat/chat.message';
import { createErrorContentFragment, DMessageContentFragment } from '~/common/stores/chat/chat.fragments';
import { apiStream } from '~/common/util/trpc.client';
import { findLLMOrThrow } from '~/common/stores/llms/store-llms';
import { getLabsDevMode, getLabsDevNoStreaming } from '~/common/state/store-ux-labs';
import { metricsStoreAddChatGenerate } from '~/common/stores/metrics/store-metrics';
import { presentErrorToHumans } from '~/common/util/errorUtils';

// NOTE: pay particular attention to the "import type", as this is importing from the server-side Zod definitions
import type { AixAPI_Access, AixAPI_ContextChatStream, AixAPI_Model, AixAPIChatGenerate_Request } from '../server/api/aix.wiretypes';

import { ContentReassembler } from './ContentReassembler';
import { ThrottleFunctionCall } from './ThrottleFunctionCall';
import { aixChatGenerateRequestFromDMessages } from './aix.client.fromDMessages.api';


export function aixCreateContext(name: AixAPI_ContextChatStream['name'], ref: AixAPI_ContextChatStream['ref']): AixAPI_ContextChatStream {
  return { method: 'chat-stream', name, ref };
}

export function aixCreateModelFromLLMOptions(llmOptions: Record<string, any>, debugLlmId: string): AixAPI_Model {
  // model params (llm)
  const { llmRef, llmTemperature, llmResponseTokens } = llmOptions || {};
  if (!llmRef || llmTemperature === undefined)
    throw new Error(`Error in configuration for model ${debugLlmId}: ${JSON.stringify(llmOptions)}`);

  return {
    id: llmRef,
    temperature: llmTemperature,
    ...(llmResponseTokens ? { maxTokens: llmResponseTokens } : {}),
  };
}


export interface AixChatGenerateDMessageUpdate extends Pick<DMessage, 'fragments' | 'generator' | 'pendingIncomplete'> {
  // overwriting in DMessage
  fragments: DMessageContentFragment[];
  generator: DMessageGenerator;
  pendingIncomplete: boolean;
}

type StreamMessageStatus = {
  outcome: 'success' | 'aborted' | 'errored',
  errorMessage?: string
};


export async function aixChatGenerateContentStreaming(
  // chat-inputs -> Partial<DMessage> outputs
  llmId: DLLMId,
  chatHistory: Readonly<DMessage[]>,
  // aix inputs
  aixContextName: AixAPI_ContextChatStream['name'],
  aixContextRef: AixAPI_ContextChatStream['ref'],
  // others
  throttleParallelThreads: number, // 0: disable, 1: default throttle (12Hz), 2+ reduce frequency with the square root
  abortSignal: AbortSignal,
  onStreamingUpdate: (update: AixChatGenerateDMessageUpdate, isDone: boolean) => void,
): Promise<StreamMessageStatus> {

  const returnStatus: StreamMessageStatus = { outcome: 'success', errorMessage: undefined };

  const aixChatContentGenerateRequest = await aixChatGenerateRequestFromDMessages(chatHistory, 'complete');

  const throttler = new ThrottleFunctionCall(throttleParallelThreads);

  const dMessageUpdate: AixChatGenerateDMessageUpdate = {
    fragments: [],
    generator: { mgt: 'named', name: llmId as any },
    pendingIncomplete: true,
  };

  try {

    await aixLLMChatGenerateContent(llmId, aixChatContentGenerateRequest, aixCreateContext(aixContextName, aixContextRef), true, abortSignal,
      (update: AixLLMGenerateContentAccumulator, isDone: boolean) => {

        // typesafe overwrite on all fields (Object.assign, but typesafe)
        dMessageUpdate.fragments = update.fragments;
        dMessageUpdate.generator = update.generator;
        dMessageUpdate.pendingIncomplete = !isDone;

        // throttle the update - and skip the last done message
        if (!isDone)
          throttler.decimate(() => onStreamingUpdate(dMessageUpdate, false));
      },
    );

  } catch (error: any) {
    // this can only be a large, user-visible error, such as LLM not found
    console.error('[DEV] aixChatGenerateContentStreaming error:', error);
    dMessageUpdate.fragments.push(
      createErrorContentFragment(`Issue: ${error.message || (typeof error === 'string' ? error : 'Chat stopped.')}`),
    );
    dMessageUpdate.generator.tokenStopReason = 'issue';
    returnStatus.outcome = 'errored';
    returnStatus.errorMessage = error.message;
  }

  // Ensure the last content is flushed out, and mark as complete
  dMessageUpdate.pendingIncomplete = false;
  throttler.finalize(() => onStreamingUpdate(dMessageUpdate, true));

  return returnStatus;
}


/**
 * Accumulator for ChatGenerate output data, as it is being streamed.
 * The object is modified in-place and passed to the callback for efficiency.
 */
export interface AixLLMGenerateContentAccumulator extends Pick<DMessage, 'fragments' | 'generator'> {
  // overwriting in DMessage
  fragments: DMessageContentFragment[];
  generator: DMessageGenerator;
}

export async function aixLLMChatGenerateContent<TServiceSettings extends object = {}, TAccess extends ChatStreamingInputSchema['access'] = ChatStreamingInputSchema['access']>(
  // llm Id input -> access & model
  llmId: DLLMId,
  // aix inputs
  aixChatGenerate: AixAPIChatGenerate_Request,
  aixContext: AixAPI_ContextChatStream,
  aixStreaming: boolean,
  // others
  abortSignal: AbortSignal,
  onStreamingUpdate?: (update: AixLLMGenerateContentAccumulator, isDone: boolean) => void,
): Promise<AixLLMGenerateContentAccumulator> {

  // Aix Access
  const llm = findLLMOrThrow(llmId);
  const { transportAccess: aixAccess, serviceSettings, vendor } = findServiceAccessOrThrow<TServiceSettings, TAccess>(llm.sId);

  // [OpenAI-only] check for harmful content with the free 'moderation' API, if the user requests so
  // if (aixAccess.dialect === 'openai' && aixAccess.moderationCheck) {
  //   const moderationUpdate = await _openAIModerationCheck(aixAccess, messages.at(-1) ?? null);
  //   if (moderationUpdate)
  //     return onUpdate({ textSoFar: moderationUpdate, typing: false }, true);
  // }

  // apply any vendor-specific rate limit
  await vendor.rateLimitChatGenerate?.(llm, serviceSettings);

  // Aix Model
  const aixModel = aixCreateModelFromLLMOptions(llm.options, llmId);

  // Aix Low-Level Chat Generation
  const contentAccumulator: AixLLMGenerateContentAccumulator = {
    fragments: [],
    generator: {
      mgt: 'aix',
      name: llmId,
      aix: {
        vId: llm.vId,
        // sId: llm.sId,
        // NOTE: using llm.id instead of aixModel.id (the ref) so we can re-select them in the UI (Beam)
        mId: llm.id,
      },
    },
  };

  function accumulate(update: Aix_LL_GenerateContentAccumulator): AixLLMGenerateContentAccumulator {
    contentAccumulator.fragments = update.fragments;
    if (update.genMetrics) contentAccumulator.generator.metrics = update.genMetrics;
    if (update.genModelName) contentAccumulator.generator.name = update.genModelName;
    if (update.genTokenStopReason) contentAccumulator.generator.tokenStopReason = update.genTokenStopReason;
    return contentAccumulator;
  }

  const optionalCallback = !onStreamingUpdate ? undefined : (update: Aix_LL_GenerateContentAccumulator, isDone: boolean) => onStreamingUpdate(accumulate(update), isDone);

  const contentFinal = await _aix_LL_ChatGenerateContent(aixAccess, aixModel, aixChatGenerate, aixContext, aixStreaming, abortSignal, optionalCallback);
  accumulate(contentFinal);

  // TODO: compute costs here, from the metrics (value.metrics: DChatGenerateMetrics) and the pricing (llm.pricing: DModelPricing)
  metricsStoreAddChatGenerate(contentFinal.genMetrics, llm.pricing?.chat);

  return contentAccumulator;
}


/**
 * Accumulator for Lower Level ChatGenerate output data, as it is being streamed.
 * The object is modified in-place and passed to the callback for efficiency.
 */
export interface Aix_LL_GenerateContentAccumulator {
  // overwriting in DMessage
  fragments: DMessageContentFragment[];

  // pieces of generator
  genMetrics?: DMessageGenerator['metrics'];
  genModelName?: DMessageGenerator['name'];
  genTokenStopReason?: DMessageGenerator['tokenStopReason'];
}


/**
 * Client side chat generation, with streaming. This decodes the (text) streaming response from
 * our server streaming endpoint (plain text, not EventSource), and signals updates via a callback.
 *
 * Vendor-specific implementation is on our server backend (API) code. This function tries to be
 * as generic as possible.
 *
 * NOTE: onUpdate is callback when a piece of a message (text, model name, typing..) is received
 */
async function _aix_LL_ChatGenerateContent(
  // aix inputs
  aixAccess: AixAPI_Access,
  aixModel: AixAPI_Model,
  aixChatGenerate: AixAPIChatGenerate_Request,
  aixContext: AixAPI_ContextChatStream,
  aixStreaming: boolean,
  // others
  abortSignal: AbortSignal,
  // optional streaming callback
  onStreamingUpdate?: (update: Aix_LL_GenerateContentAccumulator, isDone: boolean) => void,
): Promise<Aix_LL_GenerateContentAccumulator> {

  // tRPC Aix Chat Generation (streaming) API
  const particles = await apiStream.aix.chatGenerateContent.mutate({
    access: aixAccess,
    model: aixModel,
    chatGenerate: aixChatGenerate,
    context: aixContext,
    streaming: getLabsDevNoStreaming() ? false : aixStreaming, // [DEV] disable streaming if set in the UX (testing)
    connectionOptions: getLabsDevMode() ? { debugDispatchRequestbody: true } : undefined,
  }, {
    signal: abortSignal,
  });

  const contentAccumulator: Aix_LL_GenerateContentAccumulator = { fragments: [] };
  const contentReassembler = new ContentReassembler(contentAccumulator);

  try {
    for await (const particle of particles) {
      if (abortSignal.aborted)
        console.log('update', particle);
      contentReassembler.reassembleParticle(particle);
      onStreamingUpdate?.(contentAccumulator, false);
    }
  } catch (error: any) {
    // something else broke, likely a User Abort, or an Aix server error (e.g. tRPC)
    const isUserAbort1 = abortSignal.aborted;
    const isUserAbort2 = (error instanceof Error) && (error.name === 'AbortError' || (error.cause instanceof DOMException && error.cause.name === 'AbortError'));
    if (!(isUserAbort1 || isUserAbort2)) {
      if (process.env.NODE_ENV === 'development')
        console.error('[DEV] Aix streaming Error:', error);
      contentReassembler.reassembleExceptError(presentErrorToHumans(error, true, true) || 'Unknown error');
    } else {
      if (isUserAbort1 !== isUserAbort2)
        contentReassembler.reassembleExceptError(`AbortError mismatch: ${isUserAbort1} !== ${isUserAbort2}`);
      else
        contentReassembler.reassembleExceptUserAbort();
    }
  }

  // and we're done
  contentReassembler.reassembleFinalize();

  // streaming update
  onStreamingUpdate?.(contentAccumulator, true /* Last message, done */);

  // return the final accumulated message
  return contentAccumulator;
}


// Future Testing Code
//
// const sampleFC: boolean = false; // aixModel.id.indexOf('models/gemini') === -1;
// const sampleCE: boolean = false; // aixModel.id.indexOf('models/gemini') !== -1;
// if (sampleFC) {
//   aixChatGenerate.tools = [
//     {
//       type: 'function_call',
//       function_call: {
//         name: 'get_capybara_info_given_name_and_color',
//         description: 'Get the info about capybaras. Call one each per name.',
//         input_schema: {
//           properties: {
//             'name': {
//               type: 'string',
//               description: 'The name of the capybara',
//               enum: ['enrico', 'coolio'],
//             },
//             'color': {
//               type: 'string',
//               description: 'The color of the capybara. Mandatory!!',
//             },
//             // 'story': {
//             //   type: 'string',
//             //   description: 'A fantastic story about the capybara. Please 10 characters maximum.',
//             // },
//           },
//           required: ['name'],
//         },
//       },
//     },
//   ];
// }
// if (sampleCE) {
//   aixChatGenerate.tools = [
//     {
//       type: 'code_execution',
//       variant: 'gemini_auto_inline',
//     },
//   ];
// }