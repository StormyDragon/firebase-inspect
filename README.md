Firebase Inspector
===

Accepts JSON on stdin with the keys:
* firebase_config: path to the projects firebase.json.
* alias: name of the alias which to render configuration for.
* formatting: `flat-json` for terraform compatible output or `json`(default) for just a plain JSON output

Outputs a JSON structure
* projectId: name of the project pointed to by alias.
* sourceDir: function source files
* projectDir: root project (where the firebase.json file resides)
* ignore: list of nodes to ignore when packaging the source.
* runtimeConfig: the contents of the ".runtimeconfig.json" file which must be added to the archive.
* triggers: key/values where each value is a [CloudFunction](https://cloud.google.com/functions/docs/reference/rest/v1/projects.locations.functions#CloudFunction) structure. Each key is composed of region and function ID.

You may then generate a plan using Terraform which will deploy all your functions.

```terraform
data "external" "firebase-function-data" {
  program = ["npx", "@stormweyr/firebase-inspect"]

  query = {
    firebase_config = "./firebase.json"
    alias           = "default"
    formatting      = "flat-json"
  }
}

locals {
  project = "--my-project"
  region  = "us-central1"
}

provider "google" {
  project = local.project
  region  = local.region
}

data "archive_file" "prepared-source" {
  type        = "zip"
  output_path = "${path.module}/.terraform/tmp/${timestamp()}.zip"
  source_dir  = data.external.firebase-function-data.result.sourceDir
  excludes    = jsondecode(data.external.firebase-function-data.result.ignore)
}

resource "null_resource" "prepared-source-add-runtime" {
  provisioner "local-exec" {
    command = "mkfifo .runtimeconfig.json; echo ${data.external.firebase-function-data.result.runtimeConfig} > .runtimeconfig.json | zip -FI ${data.archive_file.prepared-source.output_path} .runtimeconfig.json; rm .runtimeconfig.json"
  }
}

resource "google_storage_bucket" "function-bucket" {
  name     = "${local.project}-functions"
  location = local.region
}

resource "google_storage_bucket_object" "zip" {
  # Append file MD5 to force bucket to be recreated
  name   = "function-source-${data.archive_file.prepared-source.output_md5}.zip"
  bucket = google_storage_bucket.function-bucket.name
  source = data.archive_file.prepared-source.output_path

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_cloudfunctions_function" "firebase-functions" {
  for_each    = jsondecode(data.external.firebase-function-data.result.triggers)
  name        = each.value.id
  description = "My function"
  runtime     = each.value.runtime

  available_memory_mb = lookup(each.value, "availableMemoryMb", 128)
  trigger_http        = contains(keys(each.value), "httpsTrigger") ? true : null
  timeout             = parseint(trim(lookup(each.value, "timeout", "60"), "s"), 10)
  entry_point         = each.value.entryPoint

  max_instances = lookup(each.value, "maxInstances", null)
  min_instances = lookup(each.value, "minInstances", null)

  source_archive_bucket = google_storage_bucket_object.zip.bucket
  source_archive_object = google_storage_bucket_object.zip.name

  labels = lookup(each.value, "labels", null)

  dynamic "event_trigger" {
    for_each = (contains(keys(each.value), "eventTrigger") ? { "" : each.value.eventTrigger } : {})
    content {
      event_type = event_trigger.value.eventType
      resource   = event_trigger.value.eventFilters.resource
      failure_policy {
        retry = contains(keys(event_trigger.value), "retry")
      }
    }
  }

  environment_variables = each.value.environmentVariables
}
```
