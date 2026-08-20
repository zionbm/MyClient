import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { ZodError } from "zod";
import { log } from "./logger.js";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DOWNSTREAM_SERVICE_ERROR"
  | "INTERNAL_ERROR";

export type ApiErrorResponse = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
};

function codeFromStatus(status: number): ApiErrorCode {
  if (status === HttpStatus.BAD_REQUEST) {
    return "BAD_REQUEST";
  }
  if (status === HttpStatus.UNAUTHORIZED) {
    return "UNAUTHORIZED";
  }
  if (status === HttpStatus.FORBIDDEN) {
    return "FORBIDDEN";
  }
  if (status === HttpStatus.NOT_FOUND) {
    return "NOT_FOUND";
  }
  if (status === HttpStatus.CONFLICT) {
    return "CONFLICT";
  }
  if (status === HttpStatus.BAD_GATEWAY || status === HttpStatus.SERVICE_UNAVAILABLE || status === HttpStatus.GATEWAY_TIMEOUT) {
    return "DOWNSTREAM_SERVICE_ERROR";
  }
  return "INTERNAL_ERROR";
}

function messageFromHttpException(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === "string") {
    return response;
  }
  if (typeof response === "object" && response !== null && "message" in response) {
    const message = (response as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
    if (Array.isArray(message)) {
      return message.join(", ");
    }
  }
  return exception.message;
}

function detailsFromHttpException(exception: HttpException): unknown {
  const response = exception.getResponse();
  if (typeof response === "object" && response !== null && "details" in response) {
    return (response as { details?: unknown }).details;
  }
  return undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly service: string) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ method?: string; url?: string }>();
    const response = http.getResponse<{ status: (status: number) => { send: (body: ApiErrorResponse) => void } }>();

    if (exception instanceof ZodError) {
      response.status(HttpStatus.BAD_REQUEST).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request data",
          details: exception.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        }
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).send({
        error: {
          code: codeFromStatus(status),
          message: messageFromHttpException(exception),
          details: detailsFromHttpException(exception)
        }
      });
      return;
    }

    log("error", "unhandled api error", {
      service: this.service,
      method: request.method,
      url: request.url,
      error: exception instanceof Error ? exception.message : String(exception)
    });

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error"
      }
    });
  }
}
