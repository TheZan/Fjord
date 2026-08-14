export interface IpcInteractionHooks {
  onSend: (interactionId: string, requestId: number, command: string, sentAt: number) => void;
  onSettle: (interactionId: string, requestId: number, command: string, returnedAt: number) => void;
}

export interface ActiveIpcRequest {
  interactionId: string;
  requestId: number;
}

let activeInteractionId: string | null = null;
let interactionHooks: IpcInteractionHooks | null = null;
let interactionRequestCounter = 0;

export function setIpcInteraction(interactionId: string | null) {
  activeInteractionId = interactionId;
}

export function setIpcInteractionHooks(hooks: IpcInteractionHooks | null) {
  interactionHooks = hooks;
}

export function beginIpcRequest(command: string, sentAt: number): ActiveIpcRequest | null {
  if (!activeInteractionId) return null;
  const request = {
    interactionId: activeInteractionId,
    requestId: ++interactionRequestCounter,
  };
  interactionHooks?.onSend(request.interactionId, request.requestId, command, sentAt);
  return request;
}

export function settleIpcRequest(
  request: ActiveIpcRequest,
  command: string,
  returnedAt: number,
) {
  interactionHooks?.onSettle(
    request.interactionId,
    request.requestId,
    command,
    returnedAt,
  );
}
