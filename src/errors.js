export class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const statusType = (status) => {
  if (status === 401) return "authentication_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "server_error";
};

export function errorResponse(err, { type } = {}) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  return new Response(
    JSON.stringify({
      error: {
        message: err?.message ?? "Unknown error",
        type: type ?? statusType(status),
        code: status,
      },
    }, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
