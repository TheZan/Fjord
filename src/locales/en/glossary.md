# Translation glossary

Not loaded at runtime — reference doc for translators (docs/specs/i18n.md).
This table is authoritative: a translation PR that renders `rebase` as a
Cyrillic transliteration is a review comment, not a style preference.

Terms that must sit *inside* a translated sentence are passed as i18next
interpolation variables (`{{branch}}`, `{{count}}`), never typed directly
into the translated string — branch names, SHAs, and command names are
substituted verbatim after translation.

| Term | Russian | Notes |
|---|---|---|
| commit | коммит | noun; as a verb use «закоммитить» in informal UI text, «создать коммит» in formal |
| branch | ветка | |
| merge | слияние | |
| rebase | rebase | kept in Latin — no natural Russian git-community equivalent |
| stash | stash | kept in Latin |
| pull / fetch / push | pull / fetch / push | kept in Latin — these are also literal command names elsewhere in the UI |
| checkout | checkout | kept in Latin when referring to the command; «переключиться на ветку» in prose |
| workspace | рабочее пространство | |
| repository | репозиторий | |
| remote | remote | kept in Latin when referring to the configured remote; «удалённый репозиторий» in prose |
| staged / unstaged | staged / unstaged | kept in Latin — index terminology has no stable Russian rendering |
| working tree | рабочее дерево | |
| conflict | конфликт | |
| tag | тег | |

## Adding a term

Add a row when a translation PR would otherwise have to guess. Keep the
"kept in Latin" set small — it exists for terms that double as command
names or have no accepted equivalent, not as an excuse to skip translating.
