terraform {
  required_version = ">= 1.10"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.37"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
