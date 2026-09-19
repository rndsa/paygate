import { recordEvent } from '../services/console-log.js';
const attached = Symbol('consoleAudit');
const fallbackCode = status => ({400:'INVALID',401:'UNAUTHORIZED',403:'FORBIDDEN',404:'NOT_FOUND',409:'CONFLICT',410:'EXPIRED',422:'VALIDATION_ERROR',429:'RATE_LIMITED'}[status] || (status>=500?'INTERNAL_ERROR':'OK'));

// Called only with a literal route event. No body/headers/URLs/response strings
// are retained; recordEvent revalidates every scalar against its closed vocabulary.
export function auditAction(event) {
  return (req,res,next) => {
    if (!event || res[attached]) return next();
    res[attached] = true;
    const started=Date.now();
    let captured={};
    const originalJson=res.json;
    res.json=function(body) {
      if (body && typeof body==='object' && !Array.isArray(body)) {
        const d=body.diagnostic;
        captured={code:body.code,request_id:d?.id,stage:d?.stage,provider_status:d?.provider_status};
      }
      return originalJson.call(this,body);
    };
    res.once('finish',()=>{
      recordEvent({event,user_id:res.locals?.consoleUserId ?? req.user?.id ?? null,
        code:captured.code || fallbackCode(res.statusCode),request_id:captured.request_id || req.id,
        stage:captured.stage || res.locals?.consoleStage,
        provider_status:captured.provider_status,http_status:res.statusCode,duration_ms:Date.now()-started,
        upstream_code:res.locals?.consoleUpstreamCode,upstream_request_id:res.locals?.consoleUpstreamRequestId});
    });
    next();
  };
}
