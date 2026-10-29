import type { ChangeEvent, RefObject } from 'react'
import { Loader2, Plus, Upload } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Option, Schema } from 'effect'
import type { DocumentClassification } from '@/lib/documents/classification'
import {
  VDR_DOCUMENT_FOLDERS,
  VDR_SHELL_FOLDER_VALUES,
  VDR_SHELL_FOLDERS,
} from '@/lib/vdr/document-taxonomy'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ALLOWED_VDR_EXTENSIONS, VDR_ACCESS_LEVELS, VDR_CLASSIFICATIONS } from './config'
import { useAdminVdrOperator } from './AdminVdrCapabilityContext'
import {
  COMPANY_UPLOAD_AUTO_FOLDER,
  COMPANY_UPLOAD_DEFAULT_ACCESS,
  COMPANY_UPLOAD_DEFAULT_CLASSIFICATION,
  companyUploadFolderPersistValue,
  companyUploadFolderSelectValue,
  getClassificationOption,
  vdrClassificationOr,
} from './helpers'
import { VdrLocaleSchema, vdrAccessLevelOr } from './types'
import type { VdrAccessLevel, VdrCopy, VdrLocale } from './types'
import type { VdrQueuedUpload } from '@/lib/documents/upload-queue'
import { uploadableQueueEntries } from '@/lib/documents/upload-queue'
import { VdrUploadQueue } from './VdrUploadQueue'

// ===== LA COSTURA CON EFFECT =====
// Tres fronteras entran como `string` o como override suelto: el operador
// (`company` | `admin`), la carpeta del formulario del equipo (el catálogo
// completo de `VDR_DOCUMENT_FOLDERS`) y la carpeta del cliente (`auto` más las
// cinco del shell). El `<Select>` de Radix entrega `string` sin más; un
// `onFolderChange(value)` metía esa cadena en el intent de subida. Acceso y
// confidencialidad ya se decodifican en los helpers; la carpeta no. Lo que no
// pertenece se queda con el valor que ya tenía el formulario.

const VdrUploadOperatorSchema = Schema.Literals(['company', 'admin'])
const isVdrUploadOperator = Schema.is(VdrUploadOperatorSchema)
const isVdrLocale = Schema.is(VdrLocaleSchema)

const KNOWN_ADMIN_FOLDER_VALUES = new Set(VDR_DOCUMENT_FOLDERS.map((option) => option.value))

function isAdminFolderValue(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_ADMIN_FOLDER_VALUES.has(value)
}

const AdminFolderValueSchema = Schema.declare(isAdminFolderValue)
const decodeAdminFolderValue = Schema.decodeUnknownOption(AdminFolderValueSchema)

function adminFolderValueOr(value: unknown, fallback: string): string {
  const decoded = decodeAdminFolderValue(value)
  return Option.isSome(decoded) ? decoded.value : fallback
}

const COMPANY_FOLDER_SELECT_VALUES = new Set<string>([
  COMPANY_UPLOAD_AUTO_FOLDER,
  ...VDR_SHELL_FOLDER_VALUES,
])

function isCompanyFolderSelectValue(value: unknown): value is string {
  return typeof value === 'string' && COMPANY_FOLDER_SELECT_VALUES.has(value)
}

const CompanyFolderSelectSchema = Schema.declare(isCompanyFolderSelectValue)
const decodeCompanyFolderSelect = Schema.decodeUnknownOption(CompanyFolderSelectSchema)

function persistCompanyFolderSelect(value: unknown, fallbackSelectValue: string): string {
  const decoded = decodeCompanyFolderSelect(value)
  return companyUploadFolderPersistValue(
    Option.isSome(decoded) ? decoded.value : fallbackSelectValue
  )
}

type Props = {
  copy: VdrCopy
  locale: VdrLocale
  roomTitle: string
  versionOfName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  fileInputRef: RefObject<HTMLInputElement | null>
  selectedFile: File | null
  uploadQueue: VdrQueuedUpload[]
  allowMultiple: boolean
  docName: string
  folder: string
  accessLevel: VdrAccessLevel
  classification: DocumentClassification
  isUploading: boolean
  singleUploadReconciliationRequired: boolean
  onFileSelect: (event: ChangeEvent<HTMLInputElement>) => void
  onNameChange: (value: string) => void
  onFolderChange: (value: string) => void
  onAccessChange: (value: VdrAccessLevel) => void
  onClassificationChange: (value: DocumentClassification) => void
  onCancel: () => void
  onStop: () => void
  onRemoveFile: (id: string) => void
  onUpload: () => void
  /** Override. Default: full form when the admin VDR capability context is set. */
  operator?: typeof VdrUploadOperatorSchema.Type
}

export function VdrUploadDialog({
  copy,
  locale,
  roomTitle,
  versionOfName,
  open,
  onOpenChange,
  fileInputRef,
  selectedFile,
  uploadQueue,
  allowMultiple,
  docName,
  folder,
  accessLevel,
  classification,
  isUploading,
  singleUploadReconciliationRequired,
  onFileSelect,
  onNameChange,
  onFolderChange,
  onAccessChange,
  onClassificationChange,
  onCancel,
  onStop,
  onRemoveFile,
  onUpload,
  operator,
}: Props) {
  const t = useTranslations('vdr')
  const adminFromContext = useAdminVdrOperator()
  const resolvedOperator = isVdrUploadOperator(operator) ? operator : undefined
  const isAdminForm =
    resolvedOperator === 'admin' || (resolvedOperator !== 'company' && adminFromContext)
  const labelsLocale = isVdrLocale(locale) ? locale : 'es'
  const selectedAccess = VDR_ACCESS_LEVELS.find((level) => level.value === accessLevel)
  const selectedClassification = getClassificationOption(classification)
  const canUpload = allowMultiple
    ? uploadableQueueEntries(uploadQueue).length > 0
    : selectedFile !== null && !singleUploadReconciliationRequired
  const reconciliationBlocked = !allowMultiple && singleUploadReconciliationRequired
  const companyFolderValue = companyUploadFolderSelectValue(folder)

  function handleUpload() {
    if (!isAdminForm && !versionOfName) {
      onAccessChange(COMPANY_UPLOAD_DEFAULT_ACCESS)
      onClassificationChange(COMPANY_UPLOAD_DEFAULT_CLASSIFICATION)
    }
    onUpload()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="cta" className="min-h-11">
          <Plus className="mr-2 h-4 w-4" />
          {copy.uploadDocument}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {versionOfName ? t('upload.newVersionTitle') : copy.uploadTitle}
          </DialogTitle>
          <DialogDescription>
            {versionOfName ? (
              t('upload.replaceDescription', { name: versionOfName })
            ) : isAdminForm ? (
              <>
                {copy.uploadDescription} <span className="font-medium">{roomTitle}</span>
              </>
            ) : (
              copy.companyUploadDescription
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-3">
          <div className="space-y-2">
            <Label htmlFor="vdr-file">{copy.file}</Label>
            {/* El control nativo pinta «Choose Files / No file chosen» en el
                idioma del navegador, no en el del sitio. Se queda en el DOM para
                el label y los lectores de pantalla; lo que se ve es el botón.
                Es un <input> pelado y no el `Input` del kit: el kit le pone
                `w-full`, que le gana al ancho de 1px de `sr-only`, y el control
                invisible de 510px hacía desbordar el diálogo hacia la derecha. */}
            <input
              id="vdr-file"
              ref={fileInputRef}
              type="file"
              className="sr-only"
              tabIndex={-1}
              accept={ALLOWED_VDR_EXTENSIONS.join(',')}
              multiple={allowMultiple}
              disabled={isUploading}
              onChange={onFileSelect}
            />
            <div className="flex min-w-0 items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {allowMultiple ? copy.chooseFiles : copy.chooseFile}
              </Button>
              {allowMultiple && uploadQueue.length > 0 ? null : (
                <span
                  data-testid="vdr-file-status"
                  className="text-muted-foreground min-w-0 truncate text-sm"
                >
                  {selectedFile?.name ?? copy.noFileChosen}
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-xs">{copy.fileHint}</p>
          </div>

          {allowMultiple ? (
            <VdrUploadQueue
              locale={locale}
              queue={uploadQueue}
              isUploading={isUploading}
              onRemove={onRemoveFile}
            />
          ) : null}

          {isAdminForm && (!allowMultiple || uploadQueue.length <= 1) ? (
            <div className="space-y-2">
              <Label htmlFor="docName">{copy.documentName}</Label>
              <Input
                id="docName"
                value={docName}
                disabled={isUploading}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder={copy.documentNamePlaceholder}
              />
            </div>
          ) : null}

          {isAdminForm ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="upload-folder">{copy.category}</Label>
                  <Select
                    value={folder}
                    disabled={isUploading}
                    onValueChange={(value) => onFolderChange(adminFolderValueOr(value, folder))}
                  >
                    <SelectTrigger id="upload-folder">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VDR_DOCUMENT_FOLDERS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label[labelsLocale]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="upload-access">{copy.accessLevel}</Label>
                  <Select
                    value={accessLevel}
                    disabled={isUploading}
                    onValueChange={(value) => onAccessChange(vdrAccessLevelOr(value, accessLevel))}
                  >
                    <SelectTrigger id="upload-access">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VDR_ACCESS_LEVELS.map((level) => (
                        <SelectItem key={level.value} value={level.value}>
                          {level.label[labelsLocale]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedAccess ? (
                    <p className="text-muted-foreground text-xs">
                      {selectedAccess.description[labelsLocale]}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="upload-classification">{copy.classification}</Label>
                <Select
                  value={classification}
                  disabled={isUploading}
                  onValueChange={(value) =>
                    onClassificationChange(vdrClassificationOr(value, classification))
                  }
                >
                  <SelectTrigger id="upload-classification">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VDR_CLASSIFICATIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label[labelsLocale]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  {selectedClassification.description[labelsLocale]}
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="upload-folder">{copy.folderDestination}</Label>
              <Select
                value={companyFolderValue}
                disabled={isUploading}
                onValueChange={(value) =>
                  onFolderChange(persistCompanyFolderSelect(value, companyFolderValue))
                }
              >
                <SelectTrigger id="upload-folder">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={COMPANY_UPLOAD_AUTO_FOLDER}>{copy.folderAuto}</SelectItem>
                  {VDR_SHELL_FOLDERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label[labelsLocale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">{copy.folderAutoHint}</p>
            </div>
          )}
        </div>

        {/* Misma frase que el toast de reconciliación (useCompanyVdr): el toast
            se va, el botón sigue gris y la razón tiene que quedar visible. */}
        {reconciliationBlocked ? (
          <p
            id="vdr-upload-reconciliation"
            data-testid="vdr-upload-reconciliation"
            className="text-destructive text-xs leading-5"
          >
            {t('upload.reconciliation')}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={isUploading ? onStop : onCancel}>
            {isUploading ? t('upload.stop') : copy.cancel}
          </Button>
          <Button
            onClick={handleUpload}
            disabled={isUploading || !canUpload}
            aria-describedby={reconciliationBlocked ? 'vdr-upload-reconciliation' : undefined}
          >
            {isUploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {copy.upload}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
