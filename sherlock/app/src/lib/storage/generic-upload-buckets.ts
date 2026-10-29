// Los dos buckets genéricos (los que todavía viajan por una ruta Next), con su
// guardia derivado del mismo catálogo. Antes el guardia era un `includes` sobre
// la tupla con un `as GenericUploadBucket` encima: el cast le decía a
// TypeScript que el string ya era del union justo para poder preguntarlo.
import { Schema } from 'effect'

const GenericUploadBucketSchema = Schema.Literals(['avatars', 'logos'])

export const GENERIC_UPLOAD_BUCKETS = GenericUploadBucketSchema.literals

/** El bucket llega en el FormData de `/api/upload`: entrada ajena. */
export const isGenericUploadBucket = Schema.is(GenericUploadBucketSchema)
