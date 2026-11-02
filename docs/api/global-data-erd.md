# Global data ERD

All entities in this diagram are platform-global tables in the `app` schema. They intentionally
contain no `school_id`, `tenant_id`, or organization discriminator. SAD section 10 is not available
in this repository; this classification follows the explicit ST-033 requirements.

```mermaid
erDiagram
  COUNTRIES ||--o{ SCHOOLS : "classifies"
  CURRENCIES ||--o{ SCHOOLS : "default currency"
  PLANS ||--o{ PLAN_PRICES : "has"
  CURRENCIES ||--o{ PLAN_PRICES : "denominates"

  COUNTRIES {
    uuid id PK
    text alpha2_code UK
    text alpha3_code UK
    text numeric_code UK
    text name
    boolean is_active
    timestamptz created_at
    timestamptz updated_at
  }
  CURRENCIES {
    uuid id PK
    text code UK
    text numeric_code UK
    text name
    smallint minor_unit
    boolean is_active
    timestamptz created_at
    timestamptz updated_at
  }
  SCHOOLS {
    uuid id PK
    text slug UK
    text name
    school_status status
    uuid country_id FK
    uuid default_currency_id FK
    timestamptz created_at
    timestamptz updated_at
  }
  PLANS {
    uuid id PK
    text code UK
    text display_name
    text description
    boolean is_active
    timestamptz created_at
    timestamptz updated_at
  }
  PLAN_PRICES {
    uuid id PK
    uuid plan_id FK
    uuid currency_id FK
    billing_interval billing_interval
    bigint amount_minor
    boolean is_active
    timestamptz created_at
    timestamptz updated_at
  }
  PLATFORM_SETTINGS {
    uuid id PK
    text key UK
    text description
    platform_setting_value_type value_type
    boolean boolean_value
    bigint integer_value
    text text_value
    platform_setting_sensitivity sensitivity
    boolean is_mutable
    boolean requires_restart
    timestamptz created_at
    timestamptz updated_at
  }
```

`PLAN_PRICES` additionally has the business-key uniqueness constraint
`(plan_id, currency_id, billing_interval)`. Every foreign key uses `ON UPDATE RESTRICT` and
`ON DELETE RESTRICT`.
