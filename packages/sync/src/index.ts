import {
  Core,
  EntityPayload,
  decodeStream,
  encodePayload,
  fromBuffer,
} from '@aegle/core'
import {
  BzzFeed,
  FeedParams,
  PollFeedContentOptions,
  getFeedTopic,
} from '@erebos/bzz-feed'
import { Bzz, UploadOptions } from '@erebos/bzz-node'
import { Hex, hexValue } from '@erebos/hex'
import { hash, pubKeyToAddress } from '@erebos/keccak256'
import { KeyPair, createPublic } from '@erebos/secp256k1'
import {
  Chapter,
  PartialChapter,
  TimelineReader,
  TimelineWriter,
  validateChapter,
} from '@erebos/timeline'
import { Response } from 'node-fetch'
import PQueue from 'p-queue'
import { Observable } from 'rxjs'
import { flatMap } from 'rxjs/operators'

export function getPublicAddress(keyPair: KeyPair): string {
  return pubKeyToAddress(keyPair.getPublic('array'))
}

export function getSharedTopic(encryptionKey: Buffer, name?: string): hexValue {
  return getFeedTopic({ name, topic: Hex.from(hash(encryptionKey)).value })
}

export interface FeedReadParams {
  feed: FeedParams
  encryptionKey?: Buffer
}

export function getFeedReadParams(
  writer: string, // Can be a public key (130 chars long) or an address
  name?: string,
  keyPair?: KeyPair,
): FeedReadParams {
  const pubKey = writer.length === 130 ? createPublic(writer) : null
  const feed: FeedParams = {
    user: pubKey === null ? writer : getPublicAddress(pubKey),
  }

  let encryptionKey: Buffer | undefined
  if (keyPair != null) {
    if (pubKey === null) {
      throw new Error(
        'writer argument must be a public key when keyPair is provided to derive the shared key',
      )
    }
    encryptionKey = keyPair.derive(pubKey.getPublic()).toBuffer()
    feed.topic = getSharedTopic(encryptionKey, name)
  } else if (name != null) {
    feed.name = name
  }

  return {
    feed,
    encryptionKey,
  }
}

export interface FeedWriteParams extends FeedReadParams {
  signParams?: any
}

export function getFeedWriteParams(
  keyPair: KeyPair,
  name?: string,
  reader?: string,
): FeedWriteParams {
  const user = getPublicAddress(keyPair)
  const feed: FeedParams = { user }

  let encryptionKey: Buffer | undefined
  if (reader != null) {
    const pubKey = createPublic(reader)
    encryptionKey = keyPair.derive(pubKey.getPublic()).toBuffer()
    feed.topic = getSharedTopic(encryptionKey, name)
  } else if (name != null) {
    feed.name = name
  }

  return {
    feed,
    encryptionKey,
    signParams: keyPair.getPrivate(),
  }
}
export interface ChannelParams {
  entityType: string
  name?: string
}

export interface WriterParams extends ChannelParams {
  keyPair: KeyPair
  options?: UploadOptions
  reader?: string
}

export interface ReaderParams extends ChannelParams {
  writer: string
  keyPair?: KeyPair
}

export interface SubscriberParams extends ReaderParams {
  options: PollFeedContentOptions
}

export interface SyncConfig {
  bzz: BzzFeed<NodeJS.ReadableStream, Response>
  core?: Core
}

export class Sync {
  public bzzFeed: BzzFeed<NodeJS.ReadableStream, Response>
  public core: Core

  public constructor(config: SyncConfig) {
    this.bzzFeed = config.bzz
    this.core = config.core || new Core()
  }

  public get bzz(): Bzz<NodeJS.ReadableStream, Response> {
    return this.bzzFeed.bzz
  }

  public createPublisher<T, U>(
    push: (data: T) => Promise<U>,
  ): (entity: T) => Promise<U> {
    const queue = new PQueue({ concurrency: 1 })
    return async (entity: T): Promise<U> => {
      return await queue.add(() => push(entity))
    }
  }

  public async writeFeed<T>(params: WriterParams, data: T): Promise<string> {
    const { feed, encryptionKey, signParams } = getFeedWriteParams(
      params.keyPair,
      params.name,
      params.reader,
    )
    const payload = await this.core.encodeEntity(params.entityType, data, {
      key: encryptionKey,
    })
    return await this.bzzFeed.setContent(feed, payload, undefined, signParams)
  }

  public createFeedPublisher<T>(
    params: WriterParams,
  ): (entity: T) => Promise<string> {
    const { feed, encryptionKey, signParams } = getFeedWriteParams(
      params.keyPair,
      params.name,
      params.reader,
    )
    const push = async (data: T): Promise<string> => {
      const payload = await this.core.encodeEntity(params.entityType, data, {
        key: encryptionKey,
      })
      return await this.bzzFeed.setContent(feed, payload, undefined, signParams)
    }
    return this.createPublisher<T, string>(push)
  }

  public createTimelineWriter<T>(params: WriterParams): TimelineWriter<T> {
    const { feed, encryptionKey, signParams } = getFeedWriteParams(
      params.keyPair,
      params.name,
      params.reader,
    )
    const config = { bzz: this.bzzFeed, feed, signParams }

    if (params.reader == null) {
      return new TimelineWriter<T>(config)
    }

    class EncryptedTimelineWriter extends TimelineWriter<T> {
      async write(chapter: PartialChapter): Promise<Buffer> {
        return await encodePayload(chapter, { key: encryptionKey })
      }
    }
    return new EncryptedTimelineWriter(config)
  }

  public createTimelinePublisher<T>(
    params: WriterParams,
  ): (data: T) => Promise<Chapter<EntityPayload<T>>> {
    const add = this.createTimelineWriter<EntityPayload<T>>(
      params,
    ).createAddChapter()

    return this.createPublisher<T, Chapter<EntityPayload<T>>>(
      async (data: T): Promise<Chapter<EntityPayload<T>>> => {
        const content = await this.core.validateEntity({
          type: params.entityType,
          data,
        })
        return await add({ content })
      },
    )
  }

  public async readFeed<T>(params: ReaderParams): Promise<T | null> {
    const { feed, encryptionKey } = getFeedReadParams(
      params.writer,
      params.name,
      params.keyPair,
    )

    const res = await this.bzzFeed.getContent(feed, { mode: 'raw' })
    if (res === null) {
      return null
    }

    const payload = await this.core.decodeEntityStream<T>(res.body, {
      key: encryptionKey,
    })
    return payload.data
  }

  public createFeedReader<T>(params: ReaderParams): () => Promise<T | null> {
    const { feed, encryptionKey } = getFeedReadParams(
      params.writer,
      params.name,
      params.keyPair,
    )

    return async (): Promise<T | null> => {
      const res = await this.bzzFeed.getContent(feed, { mode: 'raw' })
      if (res === null) {
        return null
      }

      const payload = await this.core.decodeEntityStream<T>(res.body, {
        key: encryptionKey,
      })
      return payload.data
    }
  }

  public createFeedSubscriber<T>(
    params: SubscriberParams,
  ): Observable<EntityPayload<T> | null> {
    const { feed, encryptionKey } = getFeedReadParams(
      params.writer,
      params.name,
      params.keyPair,
    )

    return this.bzzFeed
      .pollContent(feed, {
        changedOnly: true,
        whenEmpty: 'ignore',
        ...params.options,
        mode: 'raw',
      })
      .pipe(
        flatMap(async res => {
          return res
            ? await this.core.decodeEntityStream<T>(res.body, {
                key: encryptionKey,
              })
            : null
        }),
      )
  }

  public createTimelineReader<T = any>(
    params: ReaderParams,
  ): TimelineReader<EntityPayload<T>> {
    const { feed, encryptionKey } = getFeedReadParams(
      params.writer,
      params.name,
      params.keyPair,
    )
    const core = this.core

    class EncryptedTimelineReader extends TimelineReader<EntityPayload<T>> {
      async read(res: Response): Promise<Chapter<EntityPayload<T>>> {
        const body = await decodeStream(res.body, { key: encryptionKey })
        const chapter = validateChapter(fromBuffer(body))
        await core.validateEntity(chapter.content)
        return chapter
      }
    }

    return new EncryptedTimelineReader({ bzz: this.bzzFeed, feed })
  }
}
