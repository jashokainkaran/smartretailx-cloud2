# ---------------------------------------------------------------------------
# GitHub Actions receives short-lived AWS credentials through OIDC — no
# long-lived access key stored in GitHub, and the trust policy is limited to
# one repository and one named GitHub Environment.
#
# The role attached below is deliberately AdministratorAccess, not a
# hand-scoped policy. See ADR-042 (docs/architecture/ARCHITECTURE_DECISIONS.md)
# for the full reasoning — in short: a hand-scoped policy would need updating
# every time a new AWS service/resource type is introduced, silently blocking
# a future deploy with a bare "not authorized" error, for a risk this
# specific setup already bounds a different way — by WHO can ever assume this
# role at all (this exact repo, this exact GitHub Environment), not by what
# the role can do once assumed.
# ---------------------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github_actions" {
  count = var.github_actions_oidc_provider_arn == null ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # GitHub's own published root-CA thumbprint for this provider, not an
  # application secret. AWS validates against the real TLS certificate
  # chain for well-known providers regardless of this value, per AWS's own
  # OIDC documentation — required by the provider schema, not load-bearing.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  github_actions_oidc_provider_arn = coalesce(
    var.github_actions_oidc_provider_arn,
    try(aws_iam_openid_connect_provider.github_actions[0].arn, null),
  )
}

data "aws_iam_policy_document" "github_actions_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_actions_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # A workflow run whose job declares `environment: dev` produces exactly
    # this subject claim — this is what actually restricts which workflow
    # runs can assume the role, independent of whether that GitHub
    # Environment has a required-reviewer rule attached. Forks, other
    # repositories, and any job not targeting this named environment are
    # rejected here regardless of what the OIDC provider itself allows.
    #
    # Two exact values, not a wildcard: GitHub is rolling out immutable
    # owner/repo IDs embedded in this claim (repo:OWNER@id/REPO@id:...)
    # alongside the plain form. A StringLike wildcard covering both looks
    # tempting but is unsafe here — IAM's "*" matches "/" too, so a pattern
    # like "repo:jashokainkaran*/smartretailx-cloud2*:..." would also
    # authorize e.g. a look-alike account "jashokainkaran-x" with a repo
    # named "smartretailx-cloud2-evil". These two literal values are the
    # only two subject strings GitHub can ever actually issue for this real
    # repository, so exact StringEquals stays exact.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repository}:environment:${var.github_deployment_environment}",
        "repo:jashokainkaran@138567332/smartretailx-cloud2@1331796742:environment:${var.github_deployment_environment}",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions_deployer" {
  name               = "${local.prefix}-github-actions-deployer"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume_role.json
}

resource "aws_iam_role_policy_attachment" "github_actions_deployer_admin" {
  role       = aws_iam_role.github_actions_deployer.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "github_actions_deployer_role_arn" {
  description = "Set this non-secret value as the GitHub Actions repository variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_actions_deployer.arn
}
