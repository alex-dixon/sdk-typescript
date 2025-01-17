import { ServiceError as GrpcServiceError } from '@grpc/grpc-js';
import {
  LoadedDataConverter,
  mapFromPayloads,
  NamespaceNotFoundError,
  searchAttributePayloadConverter,
  SearchAttributes,
} from '@temporalio/common';
import { Replace } from '@temporalio/common/lib/type-helpers';
import { optionalTsToDate, tsToDate } from '@temporalio/common/lib/time';
import { decodeMapFromPayloads } from '@temporalio/common/lib/internal-non-workflow/codec-helpers';
import { temporal, google } from '@temporalio/proto';
import { RawWorkflowExecutionInfo, WorkflowExecutionInfo, WorkflowExecutionStatusName } from './types';

function workflowStatusCodeToName(code: temporal.api.enums.v1.WorkflowExecutionStatus): WorkflowExecutionStatusName {
  return workflowStatusCodeToNameInternal(code) ?? 'UNKNOWN';
}

/**
 * Intentionally leave out `default` branch to get compilation errors when new values are added
 */
function workflowStatusCodeToNameInternal(
  code: temporal.api.enums.v1.WorkflowExecutionStatus
): WorkflowExecutionStatusName {
  switch (code) {
    case temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_UNSPECIFIED:
      return 'UNSPECIFIED';
    case temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_RUNNING:
      return 'RUNNING';
    case temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_FAILED:
      return 'FAILED';
    case temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_TIMED_OUT:
      return 'TIMED_OUT';
    case temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_CANCELED:
      return 'CANCELLED';
    case temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_TERMINATED:
      return 'TERMINATED';
    case temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_COMPLETED:
      return 'COMPLETED';
    case temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW:
      return 'CONTINUED_AS_NEW';
  }
}

export async function executionInfoFromRaw<T>(
  raw: RawWorkflowExecutionInfo,
  dataConverter: LoadedDataConverter,
  rawDataToEmbed: T
): Promise<Replace<WorkflowExecutionInfo, { raw: T }>> {
  return {
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    type: raw.type!.name!,
    workflowId: raw.execution!.workflowId!,
    runId: raw.execution!.runId!,
    taskQueue: raw.taskQueue!,
    status: {
      code: raw.status!,
      name: workflowStatusCodeToName(raw.status!),
    },
    // Safe to convert to number, max history length is 50k, which is much less than Number.MAX_SAFE_INTEGER
    historyLength: raw.historyLength!.toNumber(),
    startTime: tsToDate(raw.startTime!),
    executionTime: optionalTsToDate(raw.executionTime),
    closeTime: optionalTsToDate(raw.closeTime),
    memo: await decodeMapFromPayloads(dataConverter, raw.memo?.fields),
    searchAttributes: Object.fromEntries(
      Object.entries(
        mapFromPayloads(searchAttributePayloadConverter, raw.searchAttributes?.indexedFields ?? {}) as SearchAttributes
      ).filter(([_, v]) => v && v.length > 0) // Filter out empty arrays returned by pre 1.18 servers
    ),
    parentExecution: raw.parentExecution
      ? {
          workflowId: raw.parentExecution.workflowId!,
          runId: raw.parentExecution.runId!,
        }
      : undefined,
    raw: rawDataToEmbed,
  };
}

type ErrorDetailsName = `temporal.api.errordetails.v1.${keyof typeof temporal.api.errordetails.v1}`;

/**
 * If the error type can be determined based on embedded grpc error details,
 * then rethrow the appropriate TypeScript error. Otherwise do nothing.
 *
 * This function should be used before falling back to generic error handling
 * based on grpc error code. Very few error types are currently supported, but
 * this function will be expanded over time as more server error types are added.
 */
export function rethrowKnownErrorTypes(err: GrpcServiceError): void {
  // We really don't expect multiple error details, but this really is an array, so just in case...
  for (const entry of getGrpcStatusDetails(err) ?? []) {
    if (!entry.type_url || !entry.value) continue;
    const type = entry.type_url.replace(/^type.googleapis.com\//, '') as ErrorDetailsName;

    switch (type) {
      case 'temporal.api.errordetails.v1.NamespaceNotFoundFailure': {
        const { namespace } = temporal.api.errordetails.v1.NamespaceNotFoundFailure.decode(entry.value);
        throw new NamespaceNotFoundError(namespace);
      }
    }
  }
}

function getGrpcStatusDetails(err: GrpcServiceError): google.rpc.Status['details'] | undefined {
  const statusBuffer = err.metadata.get('grpc-status-details-bin')?.[0];
  if (!statusBuffer || typeof statusBuffer === 'string') {
    return undefined;
  }
  return google.rpc.Status.decode(statusBuffer).details;
}
