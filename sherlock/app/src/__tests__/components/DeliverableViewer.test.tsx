import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseMutation = vi.hoisted(() => vi.fn())

vi.mock('convex/react', () => ({
  useMutation: mockUseMutation,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      getDownloadUrl: 'documents:getDownloadUrl',
      getDocumentAccessGrant: 'documents:getDocumentAccessGrant',
    },
  },
}))

vi.mock('next-intl', () => ({
  useLocale: () => 'es',
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values?.name ? `${key}:${values.name}` : key,
}))

import { DeliverableViewer } from '@/components/company/DeliverableViewer'

describe('DeliverableViewer', () => {
  beforeEach(() => {
    mockUseMutation.mockReset()
  })

  it('does not offer a viewer when rendition metadata has no document id', () => {
    render(
      <DeliverableViewer
        rendition={{ format: 'PDF', documentId: '' as never }}
        deliverableName="CIM"
      />
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps an HTML rendition non-executable and requests an authorized download grant', async () => {
    const getDocumentAccessGrant = vi.fn().mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_html?token=xyz',
      action: 'DOWNLOAD',
      versionId: 'version_html',
      displayName: 'Teaser · HTML',
      detectedMimeType: 'text/html',
    })
    mockUseMutation.mockReturnValue(getDocumentAccessGrant)

    render(
      <DeliverableViewer
        rendition={{ format: 'HTML', documentId: 'document_html' as never }}
        deliverableName="Teaser"
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /open/i }))

    await waitFor(() => {
      expect(getDocumentAccessGrant).toHaveBeenCalledWith({
        documentId: 'document_html',
        action: 'VIEW',
      })
    })

    expect(await screen.findByTestId('document-viewer-nopreview')).toBeInTheDocument()
    expect(screen.queryByTestId('document-viewer-iframe')).not.toBeInTheDocument()
    expect(screen.queryByTestId('document-viewer-docx')).not.toBeInTheDocument()
  })

  it('requests a VIEW grant for a spreadsheet rendition now that XLSX renders', async () => {
    const getDownloadUrl = vi.fn().mockResolvedValue('/api/documents/access/grant_xlsx?token=xyz')
    mockUseMutation.mockReturnValue(getDownloadUrl)

    render(
      <DeliverableViewer
        rendition={{ format: 'XLSX', documentId: 'document_xlsx' as never }}
        deliverableName="Modelo financiero"
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /open/i }))

    await waitFor(() => {
      expect(getDownloadUrl).toHaveBeenCalledWith({
        documentId: 'document_xlsx',
        action: 'VIEW',
      })
    })
  })

  // HTML es el formato sin renderer (se sirve como text/plain a proposito), asi
  // que es el unico que llega al fallback de descarga donde se ve el nombre.
  it('keeps the draft warning inside the viewer and draft-marks the download name', async () => {
    const getDocumentAccessGrant = vi.fn().mockResolvedValue({
      allowed: true,
      url: '/api/documents/access/grant_draft?token=xyz',
      action: 'DOWNLOAD',
      versionId: 'version_draft',
      displayName: 'draft — Teaser · HTML',
      detectedMimeType: 'text/html',
    })
    mockUseMutation.mockReturnValue(getDocumentAccessGrant)

    render(
      <DeliverableViewer
        rendition={{ format: 'HTML', documentId: 'document_draft' as never }}
        deliverableName="Teaser"
        isDraft
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /open/i }))

    expect(await screen.findByTestId('deliverable-viewer-draft-disclaimer')).toBeVisible()
    const download = await screen.findByRole('link', { name: /download/i })
    expect(download).toHaveAttribute('download', expect.stringMatching(/^draft/i))
  })
})
