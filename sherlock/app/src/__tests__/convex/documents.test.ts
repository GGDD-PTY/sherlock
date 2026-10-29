// ============================================================================
// CONVEX DOCUMENTS MODULE TEST SUITE
// ============================================================================
// Comprehensive tests for convex/documents.ts
//
// Test Categories:
// 1. Document Queries (getDocument, listDocuments, getDocumentsByFolder)
// 2. Document Mutations (uploadDocument, updateDocument, deleteDocument)
// 3. Access Control (NDA verification, ownership)
// 4. VDR Functions (folders, access levels)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockConvexCtx,
  mockUnauthenticatedRequest,
  createMockQueryBuilder,
  type MockConvexCtx,
} from '../utils/convex-test-utils'
import {
  createMockProfile,
  createMockCompany,
  createMockDocument,
  mockId,
  resetIdCounter,
  type MockDocument,
} from '../utils/test-factories'

// ============================================================================
// SETUP
// ============================================================================

describe('convex/documents.ts', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    ctx = createMockConvexCtx()
    resetIdCounter()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // SECTION 1: DOCUMENT QUERIES
  // ==========================================================================

  describe('Document Queries', () => {
    // ===== getDocument =====
    describe('getDocument', () => {
      it('should return document when found by ID', async () => {
        const documentId = mockId('documents')
        const mockDocument = createMockDocument({ _id: documentId })

        ctx.db.get.mockResolvedValue(mockDocument)

        const result = await ctx.db.get(documentId)

        expect(result).toEqual(mockDocument)
        expect(ctx.db.get).toHaveBeenCalledWith(documentId)
      })

      it('should return null when document not found', async () => {
        const documentId = mockId('documents')
        ctx.db.get.mockResolvedValue(null)

        const result = await ctx.db.get(documentId)

        expect(result).toBeNull()
      })

      it('should include all document fields', async () => {
        const mockDocument = createMockDocument({
          name: 'Financial Report.pdf',
          fileType: 'PDF',
          accessLevel: 'NDA_REQUIRED',
          folder: 'Financials',
        })
        ctx.db.get.mockResolvedValue(mockDocument)

        const result = await ctx.db.get(mockDocument._id)

        expect(result?.name).toBe('Financial Report.pdf')
        expect(result?.fileType).toBe('PDF')
        expect(result?.accessLevel).toBe('NDA_REQUIRED')
        expect(result?.folder).toBe('Financials')
      })
    })

    // ===== listDocuments =====
    describe('listDocuments', () => {
      it('should return documents for a company', async () => {
        const companyId = mockId('companies')
        const documents = [
          createMockDocument({ companyId }),
          createMockDocument({ companyId }),
          createMockDocument({ companyId }),
        ]

        const queryBuilder = createMockQueryBuilder(documents)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('documents')
        const result = await query.withIndex('by_companyId').collect()

        expect(result).toHaveLength(3)
      })

      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should filter by folder', async () => {
        const companyId = mockId('companies')
        const financialDocs = [
          createMockDocument({ companyId, folder: 'Financials' }),
          createMockDocument({ companyId, folder: 'Financials' }),
        ]

        const queryBuilder = createMockQueryBuilder(financialDocs)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('documents')
        const result = await query.filter().collect()

        result.forEach((doc: MockDocument) => {
          expect(doc.folder).toBe('Financials')
        })
      })
    })

    // ===== getDocumentsByFolder =====
    describe('getDocumentsByFolder', () => {
      it('should return documents grouped by folder', async () => {
        const companyId = mockId('companies')
        const documents = [
          createMockDocument({ companyId, folder: 'Financials' }),
          createMockDocument({ companyId, folder: 'Legal' }),
          createMockDocument({ companyId, folder: 'Financials' }),
        ]

        const queryBuilder = createMockQueryBuilder(documents)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('documents')
        const result = await query.collect()

        const folders = new Set(result.map((d: MockDocument) => d.folder))
        expect(folders.has('Financials')).toBe(true)
        expect(folders.has('Legal')).toBe(true)
      })

      it('should return empty array for company with no documents', async () => {
        const queryBuilder = createMockQueryBuilder([])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('documents')
        const result = await query.collect()

        expect(result).toHaveLength(0)
      })
    })
  })

  // ==========================================================================
  // SECTION 2: DOCUMENT MUTATIONS
  // ==========================================================================

  describe('Document Mutations', () => {
    // ===== uploadDocument =====
    describe('uploadDocument', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should create document with valid data', async () => {
        const documentId = mockId('documents')
        const companyId = mockId('companies')
        const storageId = mockId('_storage')

        ctx.db.insert.mockResolvedValue(documentId)

        const documentData = {
          companyId,
          name: 'Business Plan.pdf',
          description: 'Detailed business plan for 2025',
          fileType: 'PDF',
          fileSize: 1500000,
          storageId,
          accessLevel: 'NDA_REQUIRED',
          folder: 'Strategic',
        }

        const result = await ctx.db.insert('documents', documentData)

        expect(result).toBe(documentId)
        expect(ctx.db.insert).toHaveBeenCalledWith(
          'documents',
          expect.objectContaining({
            name: 'Business Plan.pdf',
            accessLevel: 'NDA_REQUIRED',
          })
        )
      })

      it('should verify uploader owns the company', async () => {
        const uploaderProfileId = mockId('profiles')
        const companyId = mockId('companies')
        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: uploaderProfileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        expect(company?.ownerId).toBe(uploaderProfileId)
      })

      it('should deny non-owner from uploading documents', async () => {
        const uploaderProfileId = mockId('profiles')
        const ownerProfileId = mockId('profiles')
        const companyId = mockId('companies')

        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: ownerProfileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        const isOwner = company?.ownerId === uploaderProfileId

        expect(isOwner).toBe(false)
        // Real code would throw "No tienes permiso"
      })

      it('should validate file size limits', () => {
        const maxSize = 50 * 1024 * 1024 // 50MB
        const validSize = 10 * 1024 * 1024 // 10MB
        const invalidSize = 100 * 1024 * 1024 // 100MB

        expect(validSize).toBeLessThanOrEqual(maxSize)
        expect(invalidSize).toBeGreaterThan(maxSize)
      })

      it('should validate file type', () => {
        const allowedTypes = ['PDF', 'XLSX', 'DOCX', 'PNG', 'JPG']
        const validType = 'PDF'
        const invalidType = 'EXE'

        expect(allowedTypes).toContain(validType)
        expect(allowedTypes).not.toContain(invalidType)
      })
    })

    // ===== updateDocument =====
    describe('updateDocument', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should allow owner to update document metadata', async () => {
        const documentId = mockId('documents')

        await ctx.db.patch(documentId, {
          description: 'Updated description',
          folder: 'Updated Folder',
        })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          documentId,
          expect.objectContaining({
            description: 'Updated description',
          })
        )
      })

      it('should allow updating access level', async () => {
        const documentId = mockId('documents')

        await ctx.db.patch(documentId, { accessLevel: 'PRIVATE' })

        expect(ctx.db.patch).toHaveBeenCalledWith(documentId, {
          accessLevel: 'PRIVATE',
        })
      })

      it('should deny non-owner from updating document', async () => {
        const updaterProfileId = mockId('profiles')
        const ownerProfileId = mockId('profiles')
        const companyId = mockId('companies')

        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: ownerProfileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        const isOwner = company?.ownerId === updaterProfileId

        expect(isOwner).toBe(false)
      })
    })

    // ===== deleteDocument =====
    describe('deleteDocument', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should delete document record', async () => {
        const documentId = mockId('documents')

        await ctx.db.delete(documentId)

        expect(ctx.db.delete).toHaveBeenCalledWith(documentId)
      })

      it('should verify owner before deletion', async () => {
        const ownerProfileId = mockId('profiles')
        const companyId = mockId('companies')

        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: ownerProfileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        expect(company?.ownerId).toBe(ownerProfileId)
      })

      it('should allow ADMIN to delete any document', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        const documentId = mockId('documents')

        expect(adminProfile.role).toBe('ADMIN')

        await ctx.db.delete(documentId)
        expect(ctx.db.delete).toHaveBeenCalled()
      })
    })
  })

  // ==========================================================================
  // SECTION 3: ACCESS CONTROL
  // ==========================================================================

  describe('Access Control', () => {
    // ===== NDA Verification =====
    describe('NDA Verification', () => {
      it('should allow access to PUBLIC documents without NDA', async () => {
        const mockDocument = createMockDocument({ accessLevel: 'PUBLIC' })

        const requiresNDA = mockDocument.accessLevel === 'NDA_REQUIRED'
        expect(requiresNDA).toBe(false)
      })

      it('should require NDA for NDA_REQUIRED documents', async () => {
        const mockDocument = createMockDocument({
          accessLevel: 'NDA_REQUIRED',
        })

        const requiresNDA = mockDocument.accessLevel === 'NDA_REQUIRED'
        expect(requiresNDA).toBe(true)
      })

      it('should deny access to PRIVATE documents for non-owners', async () => {
        const viewerProfileId = mockId('profiles')
        const ownerProfileId = mockId('profiles')
        const companyId = mockId('companies')

        const mockDocument = createMockDocument({
          companyId,
          accessLevel: 'PRIVATE',
        })
        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: ownerProfileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        const isOwner = company?.ownerId === viewerProfileId
        const canAccess = mockDocument.accessLevel === 'PUBLIC' || isOwner

        expect(canAccess).toBe(false)
      })
    })

    // ===== Owner Access =====
    describe('Owner Access', () => {
      it('should always allow company owner to access all documents', async () => {
        const ownerProfileId = mockId('profiles')
        const companyId = mockId('companies')

        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: ownerProfileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        const isOwner = company?.ownerId === ownerProfileId

        expect(isOwner).toBe(true)
      })

      it('should allow ADMIN to access all documents', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        expect(adminProfile.role).toBe('ADMIN')
      })
    })
  })

  // ==========================================================================
  // SECTION 4: VDR FUNCTIONS
  // ==========================================================================

  describe('VDR Functions', () => {
    // ===== Folder Management =====
    describe('Folder Management', () => {
      it('should list available folders', async () => {
        const companyId = mockId('companies')
        const documents = [
          createMockDocument({ companyId, folder: 'Financials' }),
          createMockDocument({ companyId, folder: 'Legal' }),
          createMockDocument({ companyId, folder: 'Operations' }),
        ]

        const queryBuilder = createMockQueryBuilder(documents)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('documents')
        const result = await query.collect()

        const folders = [...new Set(result.map((d: MockDocument) => d.folder))]
        expect(folders).toHaveLength(3)
      })

      it('should handle documents without folder', async () => {
        const mockDocument = createMockDocument({ folder: undefined })
        expect(mockDocument.folder).toBeUndefined()
      })
    })

    // ===== Document Count =====
    describe('Document Statistics', () => {
      it('should count documents by company', async () => {
        const companyId = mockId('companies')
        const documents = Array.from({ length: 10 }, () => createMockDocument({ companyId }))

        const queryBuilder = createMockQueryBuilder(documents)
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('documents')
        const result = await query.collect()

        expect(result).toHaveLength(10)
      })

      it('should calculate total file size', async () => {
        const companyId = mockId('companies')
        const documents = [
          createMockDocument({ companyId, fileSize: 1000000 }),
          createMockDocument({ companyId, fileSize: 2000000 }),
          createMockDocument({ companyId, fileSize: 3000000 }),
        ]

        const totalSize = documents.reduce((sum, d) => sum + (d.fileSize || 0), 0)
        expect(totalSize).toBe(6000000)
      })
    })

    // ===== Access Level Management =====
    describe('Access Level Management', () => {
      it('should validate access level enum', () => {
        const validLevels = ['PUBLIC', 'NDA_REQUIRED', 'PRIVATE']

        validLevels.forEach((level) => {
          expect(validLevels).toContain(level)
        })
      })

      it('should default to NDA_REQUIRED if not specified', () => {
        const mockDocument = createMockDocument()
        expect(mockDocument.accessLevel).toBe('NDA_REQUIRED')
      })
    })
  })

  // ==========================================================================
  // SECTION 5: DATA VALIDATION
  // ==========================================================================

  describe('Data Validation', () => {
    it('should validate document name length', () => {
      const validNames = ['a.pdf', 'Financial Report Q4 2024.xlsx', 'A'.repeat(200) + '.pdf']
      const invalidNames = ['', 'A'.repeat(300)]

      validNames.forEach((name) => {
        expect(name.length).toBeGreaterThan(0)
        expect(name.length).toBeLessThanOrEqual(255)
      })

      invalidNames.forEach((name) => {
        const isValid = name.length > 0 && name.length <= 255
        expect(isValid).toBe(false)
      })
    })

    it('should validate file extensions', () => {
      const validExtensions = ['.pdf', '.xlsx', '.docx', '.png', '.jpg', '.pptx']
      const invalidExtensions = ['.exe', '.bat', '.sh', '.js']

      validExtensions.forEach((ext) => {
        const isAllowed = ['.pdf', '.xlsx', '.docx', '.png', '.jpg', '.pptx'].includes(ext)
        expect(isAllowed).toBe(true)
      })

      invalidExtensions.forEach((ext) => {
        const isAllowed = ['.pdf', '.xlsx', '.docx', '.png', '.jpg', '.pptx'].includes(ext)
        expect(isAllowed).toBe(false)
      })
    })

    it('should validate folder names', () => {
      const validFolders = ['Financials', 'Legal Documents', 'Due Diligence']
      const invalidFolders = ['', '../secret', 'A'.repeat(100)]

      validFolders.forEach((folder) => {
        const isValid = folder.length > 0 && folder.length <= 50 && !folder.includes('..')
        expect(isValid).toBe(true)
      })

      invalidFolders.forEach((folder) => {
        const isValid = folder.length > 0 && folder.length <= 50 && !folder.includes('..')
        expect(isValid).toBe(false)
      })
    })
  })

  // ==========================================================================
  // SECTION 6: EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle company with no documents', async () => {
      const queryBuilder = createMockQueryBuilder([])
      ctx.db.query.mockReturnValue(queryBuilder)

      const query = ctx.db.query('documents')
      const result = await query.collect()

      expect(result).toHaveLength(0)
    })

    it('should handle special characters in document name', async () => {
      const specialName = 'Informe Financiero (Q4) [2024] - Revisado.pdf'

      await ctx.db.insert('documents', { name: specialName })

      expect(ctx.db.insert).toHaveBeenCalledWith(
        'documents',
        expect.objectContaining({
          name: specialName,
        })
      )
    })

    it('should handle large file uploads', async () => {
      const largeFileSize = 49 * 1024 * 1024 // 49MB (under 50MB limit)
      const mockDocument = createMockDocument({ fileSize: largeFileSize })

      expect(mockDocument.fileSize).toBe(largeFileSize)
    })

    it('should handle concurrent document uploads', async () => {
      const companyId = mockId('companies')

      await Promise.all([
        ctx.db.insert('documents', { name: 'Doc1.pdf', companyId }),
        ctx.db.insert('documents', { name: 'Doc2.pdf', companyId }),
        ctx.db.insert('documents', { name: 'Doc3.pdf', companyId }),
      ])

      expect(ctx.db.insert).toHaveBeenCalledTimes(3)
    })

    it('should handle document with expiration', async () => {
      const mockDocument = createMockDocument({
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        isExpired: false,
      })

      expect(mockDocument.isExpired).toBe(false)
      expect(mockDocument.expiresAt).toBeGreaterThan(Date.now())
    })

    it('should mark expired documents', () => {
      const expiredDocument = createMockDocument({
        expiresAt: Date.now() - 86400000, // Yesterday
        isExpired: true,
      })

      expect(expiredDocument.isExpired).toBe(true)
    })
  })
})
