import { access, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '@larksuite/channel'
import { collectImages, type ImagePort } from '../src/images.ts'
import type { HostAttachments } from '../src/host.ts'

function message(): NormalizedMessage {
  return {
    messageId: 'om_1',
    resources: [{ type: 'image', fileKey: 'img_1', fileName: 'screen.png' }],
  } as NormalizedMessage
}

function attachmentStore(maxImageBytes = 10): HostAttachments & { saveImage: ReturnType<typeof vi.fn> } {
  return {
    imageLimits: {
      maxImageBytes,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 20,
      mediaTypes: ['image/png'],
    },
    saveImage: vi.fn(async input => ({
      attachmentId: 'att_1',
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    })),
  }
}

describe('collectImages', () => {
  it('reads an accepted image only after the streamed size check and removes the temp file', async () => {
    let downloadedPath = ''
    const port: ImagePort = {
      async downloadResourceToFile(_messageId, _fileKey, _type, path) {
        downloadedPath = path
        await writeFile(path, new Uint8Array([1, 2, 3]))
        return { bytesWritten: 3, contentType: 'image/png' }
      },
    }
    const attachments = attachmentStore()

    const result = await collectImages(message(), port, attachments, true)

    expect(result.notes).toEqual([])
    expect(result.blocks).toHaveLength(1)
    const saved = attachments.saveImage.mock.calls[0]![0]!
    expect(Array.from(saved.data)).toEqual([1, 2, 3])
    expect(saved).toMatchObject({ mediaType: 'image/png', name: 'screen.png' })
    await expect(access(downloadedPath)).rejects.toThrow()
  })

  it('rejects an oversized stream without reading or saving the file', async () => {
    const port: ImagePort = {
      async downloadResourceToFile() {
        // Deliberately do not create the file. A read attempt would fail with
        // ENOENT instead of producing the size-limit note asserted below.
        return { bytesWritten: 11, contentType: 'image/png' }
      },
    }
    const attachments = attachmentStore(10)

    const result = await collectImages(message(), port, attachments, true)

    expect(result.notes).toEqual(['（一张图片超出大小上限，未附加）'])
    expect(attachments.saveImage).not.toHaveBeenCalled()
  })

  it('removes the temp file when attachment storage rejects the image', async () => {
    let downloadedPath = ''
    const port: ImagePort = {
      async downloadResourceToFile(_messageId, _fileKey, _type, path) {
        downloadedPath = path
        await writeFile(path, new Uint8Array([1]))
        return { bytesWritten: 1, contentType: 'image/png' }
      },
    }
    const attachments = attachmentStore()
    attachments.saveImage.mockRejectedValueOnce(new Error('store failed'))

    const result = await collectImages(message(), port, attachments, true)

    expect(result.notes).toEqual(['（一张图片附加失败：store failed）'])
    await expect(access(downloadedPath)).rejects.toThrow()
  })

  it('does not read or save a completed download after cancellation', async () => {
    let downloadedPath = ''
    const controller = new AbortController()
    const port: ImagePort = {
      async downloadResourceToFile(_messageId, _fileKey, _type, path) {
        downloadedPath = path
        await writeFile(path, new Uint8Array([1]))
        controller.abort()
        return { bytesWritten: 1, contentType: 'image/png' }
      },
    }
    const attachments = attachmentStore()

    const result = await collectImages(message(), port, attachments, true, controller.signal)

    expect(result).toEqual({ blocks: [], notes: [] })
    expect(attachments.saveImage).not.toHaveBeenCalled()
    await expect(access(downloadedPath)).rejects.toThrow()
  })
})
