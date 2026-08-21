/** Streamed, size-bounded intake for images attached to a Feishu message. */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedMessage, ResourceDescriptor } from '@larksuite/channel'
import type { HostAttachments, HostContentBlock } from './host.ts'

/** Resource operation used to keep untrusted payloads outside the JS heap. */
export interface ImagePort {
  downloadResourceToFile(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    destPath: string,
  ): Promise<{ readonly bytesWritten: number; readonly contentType?: string | undefined }>
}

export interface CollectedImages {
  readonly blocks: HostContentBlock[]
  readonly notes: string[]
}

/** Download accepted images, commit bounded bytes, and always remove staging files. */
export async function collectImages(
  message: NormalizedMessage,
  port: ImagePort,
  attachments: HostAttachments | undefined,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<CollectedImages> {
  const images = message.resources.filter(
    (resource: ResourceDescriptor) => resource.type === 'image',
  )
  if (images.length === 0) return emptyCollection()
  if (!enabled) {
    return noteOnly('（用户发送了 ' + images.length + ' 张图片，本渠道未向模型传递图片：attachImages 未开启）')
  }
  if (attachments === undefined) {
    return noteOnly('（用户发送了 ' + images.length + ' 张图片，但本部署没有组合附件存储，模型看不到它们）')
  }
  if (isAborted(signal)) return emptyCollection()

  const stagingDir = await mkdtemp(join(tmpdir(), 'dsh-feishu-images-'))
  const blocks: HostContentBlock[] = []
  const notes: string[] = []
  let remainingBytes = attachments.imageLimits.maxMessageImageBytes

  try {
    for (const [index, image] of images.entries()) {
      if (isAborted(signal)) break
      if (index >= attachments.imageLimits.maxImagesPerMessage) {
        notes.push('（还有 ' + (images.length - index) + ' 张图片超出单条消息上限，未附加）')
        break
      }
      const path = join(stagingDir, String(index))
      try {
        const download = await port.downloadResourceToFile(
          message.messageId,
          image.fileKey,
          'image',
          path,
        )
        if (isAborted(signal)) break

        const mediaType = acceptedMediaType(
          download.contentType,
          image.fileName,
          attachments.imageLimits.mediaTypes,
        )
        if (mediaType === undefined) {
          notes.push('（一张图片的格式 ' + (download.contentType ?? '未知') + ' 不被支持，未附加）')
          continue
        }
        if (
          download.bytesWritten > attachments.imageLimits.maxImageBytes
          || download.bytesWritten > remainingBytes
        ) {
          notes.push('（一张图片超出大小上限，未附加）')
          continue
        }

        const bytesOnDisk = (await stat(path)).size
        if (bytesOnDisk !== download.bytesWritten) throw new Error('下载大小校验失败')
        if (
          bytesOnDisk > attachments.imageLimits.maxImageBytes
          || bytesOnDisk > remainingBytes
        ) {
          notes.push('（一张图片超出大小上限，未附加）')
          continue
        }
        const data = await readFile(path)
        if (isAborted(signal)) break
        const attachment = await attachments.saveImage({
          data,
          mediaType,
          ...(image.fileName === undefined ? {} : { name: image.fileName }),
        })
        remainingBytes -= data.byteLength
        blocks.push({ type: 'image', attachment })
      } catch (error) {
        if (isAborted(signal)) break
        notes.push('（一张图片附加失败：' + errorDetail(error) + '）')
      } finally {
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
    return { blocks, notes }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function acceptedMediaType(
  contentType: string | undefined,
  fileName: string | undefined,
  accepted: readonly string[],
): string | undefined {
  const declared = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  const extension = fileName?.split('.').at(-1)?.toLowerCase()
  const inferred = extension === undefined
    ? undefined
    : 'image/' + (extension === 'jpg' ? 'jpeg' : extension)
  return [declared, inferred].find(candidate => candidate !== undefined && accepted.includes(candidate))
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function emptyCollection(): CollectedImages {
  return { blocks: [], notes: [] }
}

function noteOnly(note: string): CollectedImages {
  return { blocks: [], notes: [note] }
}
