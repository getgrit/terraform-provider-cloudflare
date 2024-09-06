import * as sdk from "@getgrit/workflows-sdk";
import type { JSONSchema7 } from "json-schema";
import * as grit from "@getgrit/api";
import path from "node:path";
import fs from "node:fs";
import { $ } from "bun";

import { z } from "zod";

const AttributeSchema = z.union([
  z.object({
    nested_type: z.object({
      attributes: z.lazy(() => AttributesSchema),
      nesting_mode: z.string().optional(),
    }),
  }),
  z.any(),
]);

const AttributesSchema = z.record(AttributeSchema);

const BlockTypeSchema = z.object({
  nesting_mode: z.string(),
  block: z
    .object({
      block_types: z.record(z.lazy(() => BlockTypeSchema)).optional(),
      attributes: z.record(z.any()).optional(),
    })
    .optional(),
});

const BlockTypesSchema = z.record(BlockTypeSchema).optional();

const ResourceSchema = z.object({
  block: z.object({
    block_types: BlockTypesSchema,
    attributes: z.record(z.any()).optional(),
  }),
});

const CloudflareSchema = z.object({
  format_version: z.string(),
  provider_schemas: z.record(
    z.object({
      resource_schemas: z.record(ResourceSchema),
    })
  ),
});

interface Result {
  resource: string;
  attribute: string;
  nestingMode: "list" | "single";
}

function findRecursiveBlockTypes(
  list: Result[],
  resource: string,
  oldBlockSchema: z.infer<typeof BlockTypesSchema>,
  newSchema: z.infer<typeof AttributesSchema>
): Result[] {
  for (const [attribute, blockType] of Object.entries(oldBlockSchema)) {
    const attributeSchema = newSchema ? newSchema[attribute] : undefined;

    const nestedSchema = attributeSchema
      ? attributeSchema.nested_type?.attributes
      : undefined;
    if (!nestedSchema) {
      grit.logging.error(`No nested schema found for ${resource}.${attribute}`);
    }

    if (blockType.nesting_mode === "list" || blockType.nesting_mode === "set") {
      const nestingMode = attributeSchema?.nested_type?.nesting_mode ?? "list";
      list.push({
        resource,
        attribute,
        nestingMode,
      });
    }

    if (blockType.block.block_types) {
      findRecursiveBlockTypes(
        list,
        resource,
        blockType.block.block_types,
        nestedSchema
      );
    }
  }

  return list;
}

function findListNestingModeBlockTypes(
  oldSchema: z.infer<typeof CloudflareSchema>,
  newSchema: z.infer<typeof CloudflareSchema>
): Result[] {
  const results: Result[] = [];

  const oldCloudflareSchema =
    oldSchema.provider_schemas["registry.terraform.io/cloudflare/cloudflare"];
  const newCloudflareSchema =
    newSchema.provider_schemas["registry.terraform.io/cloudflare/cloudflare"];
  const oldResourceSchemas = oldCloudflareSchema.resource_schemas;
  const newResourceSchemas = newCloudflareSchema.resource_schemas;

  for (const [resourceName, resourceSchema] of Object.entries(
    oldResourceSchemas
  )) {
    const oldBlockTypes = resourceSchema.block.block_types;
    const newSchemaAttributes =
      newResourceSchemas[resourceName]?.block?.attributes ?? {};
    if (oldBlockTypes) {
      findRecursiveBlockTypes(
        results,
        resourceName,
        oldBlockTypes,
        newSchemaAttributes
      );
    }
  }

  return results;
}

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object" as const,
  properties: {
    old_schema_path: { type: "string", default: "old.json" },
  },
  required: [],
} satisfies JSONSchema7;

async function generateSchema({
  targetDir,
  providerPath,
}: {
  targetDir: string;
  providerPath: string | null;
}) {
  if (providerPath) {
    const config = `provider_installation {
  dev_overrides {
    "cloudflare/cloudflare" = "${providerPath}"
  }
  direct {}
}`;
    await grit.stdlib.writeFile(
      {
        path: ".grit/workflows/stainless/dev.tfrc",
        content: config,
      },
      {}
    );
  }
  await $`terraform init`.cwd(path.join(targetDir, "examples/provider"));
  const text = await $`terraform providers schema -json`
    .cwd(path.join(targetDir, "examples/provider"))
    .env(
      providerPath
        ? {
            TF_CLI_CONFIG_FILE: path.join(
              targetDir,
              ".grit/workflows/stainless/dev.tfrc"
            ),
          }
        : {}
    )
    .text();
  return text;
}

async function buildProvider({ targetDir }: { targetDir: string }) {
  await $`go get github.com/cloudflare/cloudflare-go/v2@next`.cwd(targetDir);
  await $`go build -o terraform-provider-cloudflare .`.cwd(targetDir);
}

export default await sdk.defineWorkflow<typeof schema>({
  name: "workflow",
  options: schema,

  run: async (options) => {
    const targetDir = process.cwd();
    const oldSchemaPath = path.resolve(targetDir, options.old_schema_path);

    // First we generate the old schema
    const oldSchemaData = await generateSchema({
      targetDir,
      providerPath: null,
    });
    const oldSchema = CloudflareSchema.parse(JSON.parse(oldSchemaData));

    // Then we generate the new schema
    await buildProvider({ targetDir });
    const newSchemaData = await generateSchema({
      targetDir,
      providerPath: targetDir,
    });
    const newSchema = CloudflareSchema.parse(JSON.parse(newSchemaData));

    // Now we compare the two schemas
    const results = findListNestingModeBlockTypes(oldSchema, newSchema);

    // @ts-expect-error
    const uniqueResults = Array.from(new Set(results.map(JSON.stringify))).map(
      // @ts-expect-error
      JSON.parse
    );

    grit.logging.info(
      `Found ${uniqueResults.length} resources with list/set nesting mode block types`
    );

    const subqueries = uniqueResults.map(
      ({ resource, attribute, nestingMode }) =>
        nestingMode === "list"
          ? `  inline_cloudflare_block_to_list(\`${attribute}\`) as $block where { $block <: within \`resource "${resource}" $_ { $_ }\` }`
          : `  inline_cloudflare_block_to_map(\`${attribute}\`) as $block where { $block <: within \`resource "${resource}" $_ { $_ }\` }`
    );

    const query = `
language hcl

pattern terraform_cloudflare_v5_block_to_attribute() {
  any {
${subqueries.join(",\n")}
  }
}`;

    await grit.stdlib.writeFile(
      {
        path: `.grit/patterns/terraform_cloudflare_v5_block_to_attribute.grit`,
        content: query,
      },
      {}
    );

    return {
      success: true,
      subqueries,
    };
  },
});
