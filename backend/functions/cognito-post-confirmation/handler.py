"""Assign every newly confirmed self-registered user the customers role.

This function is deliberately tiny. Cognito is the identity system and keeps
passwords and verification codes; this trigger only applies the application's
safe default authorisation role after Cognito has confirmed an account.

Administrators are never created here. They are assigned manually by an
existing trusted administrator, so a browser can never request its own admin
privileges.
"""

import logging
import os

import boto3


logger = logging.getLogger()
logger.setLevel(logging.INFO)

cognito = boto3.client("cognito-idp")
CUSTOMER_GROUP_NAME = os.environ["CUSTOMER_GROUP_NAME"]


def handler(event, context):
    """Add a self-registered user to the customers group after confirmation."""
    if event.get("triggerSource") != "PostConfirmation_ConfirmSignUp":
        # Password resets also invoke a post-confirmation trigger. They do not
        # represent a new account and must not change a user's roles.
        return event

    cognito.admin_add_user_to_group(
        UserPoolId=event["userPoolId"],
        Username=event["userName"],
        GroupName=CUSTOMER_GROUP_NAME,
    )

    logger.info("Assigned customers role to confirmed user %s", event["userName"])
    return event
