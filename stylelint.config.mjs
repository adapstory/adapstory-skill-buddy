export default {
  extends: ['stylelint-config-standard-scss'],
  ignoreFiles: ['**/out/**', '**/dist/**', '**/release/**'],
  overrides: [
    {
      files: ['**/*.vue'],
      customSyntax: 'postcss-html',
    },
    {
      files: ['**/*.css'],
      customSyntax: 'postcss-scss',
    },
  ],
  rules: {
    'at-rule-empty-line-before': null,
    'comment-empty-line-before': null,
    'declaration-empty-line-before': null,
    'hue-degree-notation': null,
    'lightness-notation': null,
    'rule-empty-line-before': null,
    'color-hex-length': null,
    'custom-property-empty-line-before': null,
    'selector-class-pattern': null,
    'selector-pseudo-class-no-unknown': [
      true,
      {
        ignorePseudoClasses: ['deep', 'global'],
      },
    ],
    'scss/at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: ['apply', 'custom-variant', 'import', 'layer', 'theme'],
      },
    ],
  },
}
