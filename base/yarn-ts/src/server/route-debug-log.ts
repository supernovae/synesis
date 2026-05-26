import { debugProtocolLog as debugProtocolLogWithFlag } from "./http-utils.js";

export function createProtocolDebugLogger(debug: boolean): (
  logger: { info(obj: Record<string, unknown>, msg: string): void },
  reqId: string,
  path: string,
  extra: Record<string, unknown>,
) => void {
  return (logger, reqId, path, extra) => {
    debugProtocolLogWithFlag(logger, reqId, path, extra, debug);
  };
}
