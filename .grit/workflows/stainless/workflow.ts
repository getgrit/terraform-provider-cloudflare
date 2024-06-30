
import * as sdk from '@getgrit/workflows-sdk';
import type { JSONSchema7 } from 'json-schema';
import * as grit from '@getgrit/api';

import fs from 'fs';

import { z } from "zod";

const BlockTypeSchema = z.object({
  nesting_mode: z.string(),
});

const ResourceSchema = z.object({
  block: z.object({
    block_types: z.record(BlockTypeSchema).optional(),
  })
});

const CloudflareSchema = z.object({
  format_version: z.string(),
  provider_schemas: z.record(z.object({
    resource_schemas: z.record(ResourceSchema),
  })),
});

interface Result {
  resource: string;
  attribute: string;
}

function findListNestingModeBlockTypes(schema: z.infer<typeof CloudflareSchema>): Result[] {
  const results: Result[] = [];

  const cloudflareSchema = schema.provider_schemas["registry.terraform.io/cloudflare/cloudflare"];
  const resourceSchemas = cloudflareSchema.resource_schemas;

  for (const [resourceName, resourceSchema] of Object.entries(resourceSchemas)) {
    const blockTypes = resourceSchema.block.block_types;
    if (blockTypes) {
      for (const [attributeName, blockType] of Object.entries(blockTypes)) {
        if (blockType.nesting_mode === "list") {
          results.push({ resource: resourceName, attribute: attributeName });
        }
      }
    }
  }

  return results;
}

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  properties: {
    old_schema_path: { type: 'string' },
  },
  required: ['query'],
} satisfies JSONSchema7;

export default await sdk.defineWorkflow<typeof schema>({
  name: 'workflow',
  options: schema,

  run: async (options) => {
    console.log('Running workflow');
    grit.logging.info('Generating a GritQL migration for the provided Terraform schema');

    const oldSchemaPath = options.old_schema_path;
    const oldSchemaData = await fs.promises.readFile(oldSchemaPath, 'utf-8');
    const oldSchema = CloudflareSchema.parse(JSON.parse(oldSchemaData));

    const results = findListNestingModeBlockTypes(oldSchema);

    grit.logging.info(`Found ${results.length} resources with list nesting mode block types`);

    const subqueries = results.map(({ resource, attribute }) =>
      `  \`${attribute} { $block }\` => \`${attribute} = {
  $block
}\` where { $block <: within \`resource "${resource}" $_ { $_ }\` }`
    ).join(',\n');

    const query = `
language hcl

pattern terraform_cloudflare_v5() {
  or {
${subqueries}
  }
}`;

    await grit.stdlib.writeFile({
      path: `.grit/patterns/terraform_cloudflare_v5.grit`,
      content: query,
    }, {});


    return {
      success: true,
      subqueries,
    };
  }
});