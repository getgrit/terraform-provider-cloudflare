---
note: This workflow is used as input for the autogen pipeline. Use it to generate workflow.ts
---

## Terraform Provider Workflow

The goal of this workflow is to migrate between two Terraform provider versions for the `Cloudflare` API.
Your job is to generate a GritQL migration that can handle upgrading between the two provider versions.

### 1. Attribute mapping

The respective Terraform provider schema diffs have been dumped to `new.json` and `old.json`.

Many of the resources have had `block` attributes converted to lists. In the old schema, such attributes will appear like this:

```
"cloudflare_access_application": {
          "version": 0,
          "block": {
            ...
            },
            "block_types": {
              "cors_headers": {
                "nesting_mode": "list",
                "block": {
                  ...
                },
                "max_items": 1
              }
            },
          }
        },
```

We will want to generate a GritQL migration for each such block. Make sure it is scoped to the right attribute.

Here is an example for the above attribute:

```grit
language hcl

`resource "cloudflare_access_application" $_ { $attr }` where {
  $attr <: contains bubble or {
    `cors_headers { $block }` => `cors_headers = { $block }`
  }
}
```
