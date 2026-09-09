// multipart/form-data parsing using busboy.
import busboy from 'busboy';

export async function parseMultipart(
  req: import('node:http').IncomingMessage,
  buf: Buffer
): Promise<{ fields: Record<string, any>; files: Record<string, any>[] }> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    const fields: Record<string, any> = {};
    const files: Record<string, any>[] = [];
    bb.on('field', (name, val) => {
      if (fields[name] === undefined) fields[name] = val;
      else if (Array.isArray(fields[name])) fields[name].push(val);
      else fields[name] = [fields[name], val];
    });
    bb.on('file', (name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (d: Buffer) => chunks.push(d));
      stream.on('end', () => {
        files.push({
          field: name,
          name: info.filename,
          mime: info.mimeType,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    bb.on('error', reject);
    bb.on('close', () => resolve({ fields, files }));
    bb.end(buf);
  });
}
