import { HttpException, Logger, UnauthorizedException } from "@nestjs/common";
import { AllExceptionsFilter } from "./all-exceptions.filter";

describe("AllExceptionsFilter", () => {
  let response: { headersSent: boolean; status: jest.Mock; json: jest.Mock };
  let filter: AllExceptionsFilter;

  function host() {
    return {
      switchToHttp: () => ({ getResponse: () => response }),
    } as any;
  }

  beforeEach(() => {
    response = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    filter = new AllExceptionsFilter();
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  /** The app reads fields like attemptsLeft from these; flattening them broke it. */
  it("passes a deliberate error body through intact", () => {
    filter.catch(
      new HttpException({ error: "invalid_code", attemptsLeft: 3 }, 401),
      host(),
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      error: "invalid_code",
      attemptsLeft: 3,
    });
  });

  it("keeps Nest's shape for the built-in exceptions", () => {
    filter.catch(new UnauthorizedException(), host());

    expect(response.json).toHaveBeenCalledWith({
      statusCode: 401,
      message: "Unauthorized",
    });
  });

  it("reduces an unexpected error to a generic 500, never its message", () => {
    filter.catch(new Error("db password is hunter2"), host());

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: "Internal server error",
    });
  });

  it("does nothing when a webhook already answered", () => {
    response.headersSent = true;

    filter.catch(new Error("late"), host());

    expect(response.json).not.toHaveBeenCalled();
  });
});
