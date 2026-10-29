import { Archive, Loader2 } from 'lucide-react'
import { Option, Schema } from 'effect'

import {
  VDR_DOCUMENT_FOLDERS,
  VDR_SHELL_FOLDERS,
  getVdrShellFolderValue,
} from '@/lib/vdr/document-taxonomy'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { ACCESS_LEVEL_REACH, VDR_ACCESS_LEVELS } from './config'
import { vdrAccessLevelOr } from './types'
import type { EditableVdrDocument, VdrAccessLevel, VdrCopy, VdrLocale } from './types'

// ===== LA COSTURA CON EFFECT =====
// `EditableVdrDocument.accessLevel` es `string | null` —viene de una proyección,
// no de la unión— y acá se casteaba con `as VdrAccessLevel`. El casteo no lo
// convierte en uno de los tres niveles: si llegaba cualquier otra cosa,
// `ACCESS_LEVEL_REACH[previousAccess]` era `undefined`, la comparación daba
// false y la ADVERTENCIA DE DESCLASIFICACIÓN no se pintaba — justo en el
// diálogo donde el cliente está ampliando quién puede ver un documento.
//
// Ahora el nivel se decodifica contra `Schema.Literals` y lo que no es un
// nivel cae al default explícito. Lo mismo con el value que devuelve el
// `<Select>`: entra decodificado, no casteado.
//
// El `<Select>` de carpeta tenía la misma frontera sin guardia: `onFolderChange`
// recibía el `value` de Radix tal cual, tipado `string` sin más. Nada distinto
// del `accessLevel` de arriba —es el mismo `<Select>` de shadcn, el mismo
// `onValueChange: (value: string) => void`— así que ahora se decodifica contra
// el universo real de carpetas del diálogo en vez de pasar el string crudo.
//
// El universo de carpetas depende de quién abre el diálogo, igual que en el de
// subida (`VdrUploadDialog`): el equipo conserva el catálogo heredado completo
// para reclasificar documentos viejos, y el cliente solo ve las cinco carpetas
// de la sala. La guardia valida contra la lista efectiva, no contra las 17.
function folderValueGuard(options: ReadonlyArray<{ value: string }>) {
  const values = new Set(options.map((option) => option.value))
  return (value: unknown): value is string => typeof value === 'string' && values.has(value)
}

const decodeAdminFolderValue = Schema.decodeUnknownOption(
  Schema.declare(folderValueGuard(VDR_DOCUMENT_FOLDERS))
)
const decodeShellFolderValue = Schema.decodeUnknownOption(
  Schema.declare(folderValueGuard(VDR_SHELL_FOLDERS))
)

function vdrFolderValueOr(value: unknown, fallback: string, adminOperator: boolean): string {
  const decoded = adminOperator ? decodeAdminFolderValue(value) : decodeShellFolderValue(value)
  return Option.isSome(decoded) ? decoded.value : fallback
}

type EditProps = {
  copy: VdrCopy
  locale: VdrLocale
  open: boolean
  onOpenChange: (open: boolean) => void
  document: EditableVdrDocument | null
  adminOperator?: boolean
  name: string
  folder: string
  accessLevel: VdrAccessLevel
  expiresAt: string
  isSaving: boolean
  onNameChange: (value: string) => void
  onFolderChange: (value: string) => void
  onAccessChange: (value: VdrAccessLevel) => void
  onExpiresAtChange: (value: string) => void
  onSave: () => void
}

export function VdrEditDialog(props: EditProps) {
  const adminOperator = props.adminOperator === true
  const folderOptions = adminOperator ? VDR_DOCUMENT_FOLDERS : VDR_SHELL_FOLDERS
  // Un documento guardado con una carpeta heredada se muestra en la carpeta que
  // la sala ya le dibuja; si no, el trigger del cliente abriría vacío.
  const folderValue = adminOperator ? props.folder : getVdrShellFolderValue(props.folder)
  const previousAccess = vdrAccessLevelOr(props.document?.accessLevel)
  const widening = ACCESS_LEVEL_REACH[props.accessLevel] < ACCESS_LEVEL_REACH[previousAccess]

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{props.copy.editTitle}</DialogTitle>
          <DialogDescription>{props.copy.editDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-doc-name">{props.copy.documentName}</Label>
            <Input
              id="edit-doc-name"
              value={props.name}
              onChange={(event) => props.onNameChange(event.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="edit-doc-folder">{props.copy.category}</Label>
              <Select
                value={folderValue}
                onValueChange={(value) =>
                  props.onFolderChange(vdrFolderValueOr(value, folderValue, adminOperator))
                }
              >
                <SelectTrigger id="edit-doc-folder">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {folderOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label[props.locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-doc-access">{props.copy.accessLevel}</Label>
              <Select
                value={props.accessLevel}
                onValueChange={(value) =>
                  props.onAccessChange(vdrAccessLevelOr(value, props.accessLevel))
                }
              >
                <SelectTrigger id="edit-doc-access">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VDR_ACCESS_LEVELS.map((level) => (
                    <SelectItem key={level.value} value={level.value}>
                      {level.label[props.locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {widening ? (
            <p className="text-destructive text-sm">{props.copy.declassifyWarning}</p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="edit-doc-expires">{props.copy.expiresAt}</Label>
            <Input
              id="edit-doc-expires"
              type="date"
              value={props.expiresAt}
              onChange={(event) => props.onExpiresAtChange(event.target.value)}
            />
            <p className="text-muted-foreground text-sm">{props.copy.expiresAtHint}</p>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={props.isSaving}
          >
            {props.copy.cancel}
          </Button>
          <Button onClick={props.onSave} disabled={props.isSaving || !props.name.trim()}>
            {props.isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {props.copy.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type DeleteProps = {
  copy: VdrCopy
  open: boolean
  onOpenChange: (open: boolean) => void
  documentName?: string
  /** El documento lo entregó el equipo: el diálogo avisa que le va a llegar. */
  isTeamDelivery?: boolean
  isDeleting: boolean
  onDelete: () => void
}

export function VdrDeleteDialog(props: DeleteProps) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.copy.deleteTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {props.copy.deleteDescription(props.documentName, props.isTeamDelivery)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={props.isDeleting}>{props.copy.cancel}</AlertDialogCancel>
          <AlertDialogAction onClick={props.onDelete} disabled={props.isDeleting}>
            {props.isDeleting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Archive className="mr-2 h-4 w-4" />
            )}
            {props.copy.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
