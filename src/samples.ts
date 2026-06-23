// Starter artifacts for each format. Intentionally imperfect so rules fire.
export const SAMPLES: Record<'openapi' | 'asyncapi' | 'jsonschema', string> = {
  openapi: `openapi: "3.0.3"
info:
  title: Pet Store
  version: "1.0.0"
paths:
  /Pets:
    get:
      responses:
        "200":
          description: A list of pets.
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Pet"
components:
  schemas:
    Pet:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
`,
  asyncapi: `asyncapi: "2.6.0"
info:
  title: Account Events
  version: "1.0.0"
channels:
  user/signedup:
    subscribe:
      message:
        payload:
          type: object
          properties:
            id:
              type: string
`,
  jsonschema: `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Pet",
  "type": "object",
  "properties": {
    "id": { "type": "integer" },
    "name": { "type": "string" }
  },
  "required": ["id"]
}
`,
};
