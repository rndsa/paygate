// Express 4 does not forward rejected handler promises to error middleware.
export const asyncRoute = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
