/**
 * zip.ts: the files of a zip GitHub sends, such as a run attempt's logs: each stored or deflated,
 * in one disk, with no zip64. Enough for those, not for any zip.
 *
 * Runs: imported by `ci-health.ts`, which reads one log zip per attempt (one API call for every
 * job's log, instead of one call per job).
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** Each file of `zip`, in its directory's order. */
export const unzipEntries = (zip: Buffer): ReadonlyArray<ZipEntry> => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip');

  const count = zip.readUInt16LE(end + 10);
  const entries: Array<ZipEntry> = [];

  for (let at = zip.readUInt32LE(end + 16), index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip directory');

    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);

    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');

    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error('unknown zip method');

    entries.push({ name, data: method === 0 ? data : inflateRawSync(data) });
  }

  return entries;
};

/** A zip of `files`, each stored uncompressed, with no CRC: for tests of `unzipEntries` only. */
export const storedZip = (files: ReadonlyArray<readonly [string, string]>) => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;

  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
};
