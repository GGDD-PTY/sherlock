// ============================================================================
// COMMITLINT CONFIG
// ============================================================================
// Valida que los mensajes de commit sigan Conventional Commits:
// - feat: Nueva funcionalidad
// - fix: Bug fix
// - refactor: Refactorización sin cambio de funcionalidad
// - docs: Documentación
// - test: Tests
// - chore: Tareas de mantenimiento
// - security: Cambios de seguridad
// - perf: Mejoras de performance
//
// Ejemplo válido: "feat: add dark mode toggle"
// Ejemplo inválido: "fixed stuff"
// ============================================================================

module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Tipos permitidos (extiende los default + agrega custom)
    'type-enum': [
      2,
      'always',
      [
        'feat', // Nueva funcionalidad
        'fix', // Bug fix
        'refactor', // Refactorización
        'docs', // Documentación
        'test', // Tests
        'chore', // Mantenimiento
        'security', // Seguridad
        'perf', // Performance
        'style', // Formato/estilo (sin cambio de lógica)
        'ci', // CI/CD changes
        'revert', // Revert de commit anterior
        'build', // Build system
      ],
    ],
    // Subject no puede estar vacío
    'subject-empty': [2, 'never'],
    // Type no puede estar vacío
    'type-empty': [2, 'never'],
    // Subject en minúsculas
    'subject-case': [2, 'always', 'lower-case'],
    // Máximo 100 caracteres en header
    'header-max-length': [2, 'always', 100],
  },
}
