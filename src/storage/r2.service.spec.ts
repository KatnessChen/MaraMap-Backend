import { Readable } from 'stream';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { R2Service } from './r2.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn(),
}));

const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;
const MockUpload = Upload as jest.MockedClass<typeof Upload>;

describe('R2Service', () => {
  let service: R2Service;
  let send: jest.Mock;

  beforeEach(() => {
    process.env.R2_BUCKET_NAME = 'bucket';
    process.env.R2_PUBLIC_URL = 'https://cdn.test';
    process.env.R2_ENDPOINT = 'https://acc.r2.cloudflarestorage.com';
    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';

    service = new R2Service();
    send = jest.fn();
    // R2Service constructs its own S3Client internally (no DI seam for it),
    // so the only way to stub the wire call is to reach into the private field.
    (service as unknown as { client: { send: jest.Mock } }).client.send = send;
    jest.clearAllMocks();
  });

  describe('keyFromUrl', () => {
    it('strips the public URL prefix', () => {
      expect(service.keyFromUrl('https://cdn.test/media/a.jpg')).toBe(
        'media/a.jpg',
      );
    });

    it('passes legacy bare keys through', () => {
      expect(service.keyFromUrl('media/a.jpg')).toBe('media/a.jpg');
    });

    it('rejects foreign absolute URLs and empty values', () => {
      expect(service.keyFromUrl('https://elsewhere.test/a.jpg')).toBeNull();
      expect(service.keyFromUrl(null)).toBeNull();
    });
  });

  it('upload puts the buffer and returns the public URL', async () => {
    send.mockResolvedValue({});
    const url = await service.upload(
      'k/a.json',
      Buffer.from('{}'),
      'application/json',
    );
    expect(url).toBe('https://cdn.test/k/a.json');
    const input = send.mock.calls[0][0].input;
    expect(input).toMatchObject({
      Bucket: 'bucket',
      Key: 'k/a.json',
      ContentType: 'application/json',
    });
  });

  it('copy issues a same-bucket server-side copy', async () => {
    send.mockResolvedValue({});
    await service.copy('src/a', 'dest/a');
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'bucket',
      CopySource: 'bucket/src/a',
      Key: 'dest/a',
    });
  });

  it('delete never throws, even when the request fails', async () => {
    send.mockRejectedValue(new Error('boom'));
    await expect(service.delete('k')).resolves.toBeUndefined();
  });

  it('presignPut signs a PUT for the given key and content type', async () => {
    mockGetSignedUrl.mockResolvedValue('https://signed.example');
    await expect(service.presignPut('up.zip', 'application/zip')).resolves.toBe(
      'https://signed.example',
    );
    const [, command, opts] = mockGetSignedUrl.mock.calls[0];
    expect((command as unknown as { input: unknown }).input).toMatchObject({
      Bucket: 'bucket',
      Key: 'up.zip',
      ContentType: 'application/zip',
    });
    expect(opts).toEqual({ expiresIn: 3600 });
  });

  it('headSize returns the content length', async () => {
    send.mockResolvedValue({ ContentLength: 42 });
    await expect(service.headSize('k')).resolves.toBe(42);
  });

  it('exists reflects whether HeadObject succeeds', async () => {
    send.mockResolvedValueOnce({});
    await expect(service.exists('k')).resolves.toBe(true);
    send.mockRejectedValueOnce(new Error('404'));
    await expect(service.exists('k')).resolves.toBe(false);
  });

  it('getStream forwards the byte range', async () => {
    const body = Readable.from('abc');
    send.mockResolvedValue({ Body: body });
    await expect(service.getStream('k', 'bytes=0-2')).resolves.toBe(body);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: 'k',
      Range: 'bytes=0-2',
    });
  });

  describe('getJson', () => {
    it('parses the object body', async () => {
      send.mockResolvedValue({ Body: Readable.from(Buffer.from('{"a":1}')) });
      await expect(service.getJson('k')).resolves.toEqual({ a: 1 });
    });

    it('returns null for a missing key', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('nope'), { name: 'NoSuchKey' }),
      );
      await expect(service.getJson('missing')).resolves.toBeNull();
    });

    it('rethrows other failures', async () => {
      send.mockRejectedValue(new Error('network down'));
      await expect(service.getJson('k')).rejects.toThrow('network down');
    });
  });

  it('putJson uploads pretty-printed JSON', async () => {
    send.mockResolvedValue({});
    await service.putJson('k.json', { a: 1 });
    const input = send.mock.calls[0][0].input;
    expect(input.ContentType).toBe('application/json');
    expect(JSON.parse(input.Body.toString())).toEqual({ a: 1 });
  });

  it('uploadStream delegates to lib-storage', async () => {
    const done = jest.fn().mockResolvedValue(undefined);
    MockUpload.mockImplementation(() => ({ done }) as never);
    const body = Readable.from('x');

    await service.uploadStream('k.jpg', body, 'image/jpeg');

    expect(MockUpload.mock.calls[0][0].params).toMatchObject({
      Bucket: 'bucket',
      Key: 'k.jpg',
      Body: body,
      ContentType: 'image/jpeg',
    });
    expect(done).toHaveBeenCalled();
  });

  it('list walks every page', async () => {
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'a' }],
        IsTruncated: true,
        NextContinuationToken: 't',
      })
      .mockResolvedValueOnce({ Contents: [{ Key: 'b' }] });

    await expect(service.list('p/')).resolves.toEqual(['a', 'b']);
    expect(send.mock.calls[1][0].input.ContinuationToken).toBe('t');
  });

  it('listPrefixes returns delimiter groupings', async () => {
    send.mockResolvedValue({
      CommonPrefixes: [{ Prefix: 'p/batch-1/' }, { Prefix: 'p/batch-2/' }],
    });
    await expect(service.listPrefixes('p/')).resolves.toEqual([
      'p/batch-1/',
      'p/batch-2/',
    ]);
    expect(send.mock.calls[0][0].input.Delimiter).toBe('/');
  });

  it('deletePrefix removes every listed key and reports the count', async () => {
    send
      .mockResolvedValueOnce({ Contents: [{ Key: 'p/a' }, { Key: 'p/b' }] })
      .mockResolvedValueOnce({});

    await expect(service.deletePrefix('p/')).resolves.toBe(2);
    expect(send.mock.calls[1][0].input.Delete.Objects).toEqual([
      { Key: 'p/a' },
      { Key: 'p/b' },
    ]);
  });
});
