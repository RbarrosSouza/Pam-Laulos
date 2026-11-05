# Add only the directed state/ensure API to the exact image already deployed.
# The build has no dependency installation, asset compilation or network step.
FROM ghcr.io/fazer-ai/chatwoot@sha256:924c852c0d5a231a4c1b63b0d22a55c0fb5ab899d73eb59986d7ceb5a05ff048
COPY reactions_controller.rb /app/app/controllers/api/v1/accounts/conversations/messages/reactions_controller.rb
COPY patch-routes.rb /tmp/pamvet-check-patch-routes.rb
RUN ruby /tmp/pamvet-check-patch-routes.rb /app/config/routes.rb \
 && chmod 0644 /app/app/controllers/api/v1/accounts/conversations/messages/reactions_controller.rb \
 && rm /tmp/pamvet-check-patch-routes.rb
