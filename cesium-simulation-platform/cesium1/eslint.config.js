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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'off', // TypeScript handles this
      // 规模告警阈值按本仓库实际口径校准（2026-09 结构化拆分后：巨型文件已消化，
      // 正常模块规模在 100~1500 行、核心算法函数 120~250 行）。
      // 超过即提示拆分；数值过低的阈值只会造成告警疲劳（141 条长期告警无人看）。
      'max-lines': ['warn', { max: 1500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 200, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 15],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'onerror',
          message: '请使用 globalErrorCapture.js 统一注册全局错误捕获'
        },
        {
          object: 'window',
          property: 'onunhandledrejection',
          message: '请使用 globalErrorCapture.js 统一注册全局错误捕获'
        }
      ]
    },
    languageOptions: {
      globals: {
        Cesium: 'readonly',
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        performance: 'readonly',
        CustomEvent: 'readonly'
      }
    }
  },
  {
    files: ['src/App.vue', 'src/components/**/*.{js,vue}', 'src/composables/**/*.{js,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*/services/*'],
              message: '入口层请优先通过 @/features/shared/index.js 使用功能模块公共 API'
            }
          ]
        }
      ]
    }
  },
  {
    ignores: ['dist/*', 'public/*', 'coverage/*']
  }
]
