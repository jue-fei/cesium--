const js = require('@eslint/js')
const pluginVue = require('eslint-plugin-vue')
const prettier = require('eslint-plugin-prettier/recommended')

module.exports = [
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  prettier,
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      'no-unused-vars': 'warn',
      'no-undef': 'off' // TypeScript handles this
    },
    languageOptions: {
      globals: {
        Cesium: 'readonly',
        window: 'readonly',
        document: 'readonly',
        console: 'readonly'
      }
    }
  },
  {
    ignores: ['dist/*', 'public/*', 'coverage/*']
  }
]
