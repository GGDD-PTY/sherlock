import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ImageViewer } from '@/components/documents/viewers/ImageViewer'

describe('ImageViewer', () => {
  it('contains tall raster images in a scrollable viewer surface', () => {
    render(<ImageViewer viewUrl="/grant/tall" fileName="planta-alta.png" />)

    const image = screen.getByTestId('document-viewer-image')
    expect(image).toHaveClass('max-h-full', 'object-contain')
    expect(image.parentElement).toHaveClass('h-full', 'overflow-auto')
  })
})
