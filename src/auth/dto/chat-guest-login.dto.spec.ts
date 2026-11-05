import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChatGuestLoginDto } from './chat-guest-login.dto';

describe('ChatGuestLoginDto', () => {
  const errorsFor = async (body: object) => {
    const dto = plainToInstance(ChatGuestLoginDto, body);
    return { dto, errors: await validate(dto) };
  };

  it('accepts a digit passcode and trims the nickname', async () => {
    const { dto, errors } = await errorsFor({
      passcode: '000',
      nickname: '  小明  ',
    });
    expect(errors).toEqual([]);
    expect(dto.nickname).toBe('小明');
  });

  it.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(21)],
    ['line break', '小\n明'],
    ['text direction override', '小‮明'],
  ])('rejects a %s nickname', async (_label, nickname) => {
    const { errors } = await errorsFor({ passcode: '000', nickname });
    expect(errors.map((error) => error.property)).toEqual(['nickname']);
  });

  it('requires a nickname', async () => {
    const { errors } = await errorsFor({ passcode: '000' });
    expect(errors.map((error) => error.property)).toEqual(['nickname']);
  });

  it('rejects a passcode with anything but digits', async () => {
    const { errors } = await errorsFor({ passcode: '12ab', nickname: '小明' });
    expect(errors.map((error) => error.property)).toEqual(['passcode']);
  });
});
