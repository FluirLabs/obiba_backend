import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { BlockSource } from '@obiba/near';
import { BLOCK_STREAM, type Ingestor } from './ingestor';

export interface StreamStatus {
  cursor: bigint | null;
  final: bigint;
  processed: number;
}

export class BlockStreamer {
  constructor(
    private readonly pool: Pool,
    private readonly source: BlockSource,
    private readonly ingestor: Pick<Ingestor, 'ingestBlock'>,
    private readonly startHeight: bigint | null,
    private readonly log: Logger,
  ) {}

  async cursor(): Promise<bigint | null> {
    const r = await this.pool.query<{ block_height: string }>('select block_height::text from chain.cursor where stream = $1', [BLOCK_STREAM]);
    return r.rows[0] ? BigInt(r.rows[0].block_height) : null;
  }

  async step(maxBlocks = 50): Promise<StreamStatus> {
    const stored = await this.cursor();
    const final = await this.source.finalHeight();
    let cursor: bigint;
    if (stored === null) {
      if (this.startHeight === null) throw new Error('block stream has no cursor; set BLOCK_STREAM_START to the first height to index');
      if (this.startHeight > final) return { cursor: null, final, processed: 0 };
      await this.ingestor.ingestBlock(await this.source.block(this.startHeight), this.startHeight, null);
      cursor = this.startHeight;
    } else {
      cursor = stored;
    }
    let processed = 0;
    while (processed < maxBlocks && cursor < final) {
      const height: bigint = cursor + 1n;
      const block = await this.source.block(height);
      if (block && block.height !== height) throw new Error(`block source returned height ${block.height} for ${height}`);
      await this.ingestor.ingestBlock(block, height, cursor);
      cursor = height;
      processed++;
    }
    if (processed > 0) this.log.debug({ cursor: cursor.toString(), final: final.toString() }, 'block stream advanced');
    return { cursor, final, processed };
  }
}
