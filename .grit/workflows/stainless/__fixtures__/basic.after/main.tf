# This is our baseline config
# We just use this as a sanity check and base for generating schemas.

# Configure the Cloudflare provider using the required_providers stanza
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

# Sample resource with block attributes
resource "cloudflare_access_application" "staging_app" {
  zone_id          = "0da42c8d2132a9ddaf714f9e7c920711"
  name             = "staging application"
  domain           = "staging.example.com"
  type             = "self_hosted"
  session_duration = "24h"

  # cors is a currently a block list
  cors_headers = { allowed_methods = "GET"
    allowed_origins   = "https://example.com"
    allow_credentials = true
  max_age = 10 }
}
