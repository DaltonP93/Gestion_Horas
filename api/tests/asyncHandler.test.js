/**
 * Tests de asyncHandler: una promesa rechazada debe llegar a next(err),
 * no quedar como unhandledRejection.
 */
const { asyncHandler, HttpError } = require('../src/utils/asyncHandler');

describe('asyncHandler()', () => {
  test('handler exitoso no llama next', async () => {
    const next = jest.fn();
    const res = { json: jest.fn() };
    await asyncHandler(async (req, r) => { r.json({ ok: true }); })({}, res, next);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  test('handler que lanza → next(err)', async () => {
    const next = jest.fn();
    const err = new Error('boom');
    await asyncHandler(async () => { throw err; })({}, {}, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  test('rechazo de promesa → next(err)', async () => {
    const next = jest.fn();
    await asyncHandler(() => Promise.reject(new Error('rejected')))({}, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('HttpError', () => {
  test('guarda status y code', () => {
    const e = new HttpError(404, 'No existe', 'NOT_FOUND');
    expect(e.status).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('No existe');
    expect(e).toBeInstanceOf(Error);
  });
});
