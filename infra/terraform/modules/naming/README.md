# `naming`

Derives the canonical resource-name prefix and tag set for one environment. It declares no
resources and calls no provider, so it costs nothing to consume and plans without credentials.

Every other module and resource in this repo takes its name from `name_prefix` and inherits
`tags` through the root module's `provider "aws" { default_tags { … } }`. That is the whole
point: naming and tagging are decided once, here, not restated per resource.

## Usage

```hcl
module "naming" {
  source = "./modules/naming"

  project     = "studafy"
  environment = "prod"
  extra_tags  = { CostCenter = "platform" }
}

# module.naming.name_prefix => "studafy-prod"
# module.naming.tags        => { Project = "studafy", Environment = "prod",
#                                ManagedBy = "terraform", CostCenter = "platform" }
```

## Inputs

| Name          | Type          | Default | Description                                        |
| ------------- | ------------- | ------- | -------------------------------------------------- |
| `project`     | `string`      | —       | Project slug.                                      |
| `environment` | `string`      | —       | One of `dev`, `staging`, `prod`.                   |
| `extra_tags`  | `map(string)` | `{}`    | Merged last, so it can override a canonical value. |

## Outputs

| Name          | Description                                       |
| ------------- | ------------------------------------------------- |
| `name_prefix` | `"<project>-<environment>"`.                      |
| `tags`        | `Project` + `Environment` + `ManagedBy` + extras. |
