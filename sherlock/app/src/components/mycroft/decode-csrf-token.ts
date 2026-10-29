import { Schema } from 'effect'

// El token CSRF llega en JSON de `/api/intake/*`. Sin esta forma el caller
// casteaba el cuerpo y leía `.csrfToken` a ciegas.
export const decodeCsrfToken = Schema.decodeUnknownOption(
  Schema.Struct({ csrfToken: Schema.String })
)
