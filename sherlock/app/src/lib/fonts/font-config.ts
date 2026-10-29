import { Schema } from 'effect'

// Las tres formas de decir que sí en una variable de entorno, declaradas.
const TruthyEnvValueSchema = Schema.Literals(['1', 'true', 'yes'])
const isTruthyEnvValue = Schema.is(TruthyEnvValueSchema)

type EnvLike = Record<string, string | undefined>

export function shouldDisableRemoteFonts(env: EnvLike = process.env) {
  return isTruthyEnvValue(env.NEXT_DISABLE_REMOTE_FONTS?.trim().toLowerCase())
}

export function getRootFontClassName({
  env = process.env,
  remoteFontVariables,
}: {
  env?: EnvLike
  remoteFontVariables: string
}) {
  const trimmedRemoteFontVariables = remoteFontVariables.trim()
  const fontVariables =
    shouldDisableRemoteFonts(env) || !trimmedRemoteFontVariables
      ? 'font-fallback-vars'
      : trimmedRemoteFontVariables

  return [fontVariables, 'font-sans', 'antialiased'].filter(Boolean).join(' ')
}
