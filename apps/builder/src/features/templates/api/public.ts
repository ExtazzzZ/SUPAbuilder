import {
  resolveTenantSettings,
  type TemplateActor,
  type TemplateDetail,
  templateInstallationRequestService,
  templateService,
  templateSyncRequestService,
} from "@chatbotx.io/business"
import { templateSyncExecuteService } from "@chatbotx.io/business/template-sync/execute"
import { templateUninstallService } from "@chatbotx.io/business/template-uninstall"
import {
  templateSyncStatuses,
  templateSyncTriggers,
} from "@chatbotx.io/database/partials"
import { z } from "zod"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnCreatingResource,
  possibleErrorsOnDeletingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnListingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  enqueueInstall,
  enqueueSync,
  requestTemplateInstall,
} from "../lib/request-install"
import { parseShareExpiry } from "../lib/share-expiry"
import { listLockedTemplateResourceIds } from "../queries/list-locked-ids"
import { listSelectableResources } from "../queries/list-selectable-resources"
import { previewTemplateDependencies } from "../queries/preview-dependencies"
import { previewInstallCollisionsForShare } from "../queries/preview-install-collisions"
import {
  createTemplatePublicRequest,
  getSyncPublicRequest,
  getSyncPublicResponse,
  installationDetailResponse,
  installationIdRequest,
  installTemplatePublicRequest,
  installTemplatePublicResponse,
  listInstallationResourcesRequest,
  listInstallationResourcesResponse,
  listInstallationsPublicRequest,
  listInstallationsPublicResponse,
  listLockedResourcesPublicRequest,
  listLockedResourcesResponse,
  listSelectableResourcesPublicRequest,
  listSyncsPublicResponse,
  listTemplateInstallersPublicRequest,
  listTemplateInstallersPublicResponse,
  previewTemplateDependenciesPublicRequest,
  previewTemplatePublicRequest,
  publicSelectableResourcesResponse,
  publicTemplateListItemResource,
  publicTemplatePreviewResponse,
  publicTemplateResource,
  publisherInstallerRequest,
  restoreBackupPublicRequest,
  syncInstallationPublicRequest,
  syncInstallationPublicResponse,
  templateAnalyticsResponse,
  templateDependenciesResponse,
  templateIdRequest,
  templateLinkResponse,
  uninstallInstallationPublicResponse,
  uninstallInstallerPublicResponse,
  updateInstallationPublicRequest,
  updateTemplatePublicRequest,
  updateTemplateSharePublicRequest,
} from "../schema/public"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("templates")

const TAGS = ["Templates"]
const INSTALLATION_TAGS = ["Template installations"]

const templateSyncStatusesSchema = z.enum(templateSyncStatuses.options)
const templateSyncTriggersSchema = z.enum(templateSyncTriggers.options)
const syncCountsSchema = z.object({
  created: z.number(),
  updated: z.number(),
  detached: z.number(),
  overwrittenModified: z.number(),
  notUpdatable: z.number(),
})

type TokenContext = {
  apiToken?: { permission: string } | undefined
}

/** The token's own power; anything but an explicit `full` token is read-only. */
const tokenActor = (context: TokenContext): TemplateActor => ({
  kind: "apiToken",
  permission: context.apiToken?.permission === "full" ? "full" : "read_only",
})

type TemplateRow = Omit<
  TemplateDetail,
  "selection" | "shareToken" | "payloadHash"
>

const toPublicTemplateBase = (row: TemplateRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  imageUrl: row.imageUrl,
  publisherName: row.publisherName,
  youtubeVideoId: row.youtubeVideoId,
  testLink: row.testLink,
  defaultPermissions: row.defaultPermissions,
  createInstallFolder: row.createInstallFolder,
  defaultAutoUpdate: row.defaultAutoUpdate,
  shareEnabled: row.shareEnabled,
  shareExpiresAt: row.shareExpiresAt,
  categoryCounts: row.categoryCounts,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const toPublicTemplate = (row: TemplateDetail) => ({
  ...toPublicTemplateBase(row),
  selection: row.selection,
})

const shareLink = async (
  workspaceId: string,
  row: {
    shareToken: string
    shareEnabled: boolean
    shareExpiresAt: Date | null
  },
) => {
  const { appUrl } = await resolveTenantSettings({ workspaceId })
  return {
    url: new URL(`/t/${row.shareToken}`, appUrl).toString(),
    shareEnabled: row.shareEnabled,
    shareExpiresAt: row.shareExpiresAt,
  }
}

const templatesPublicRouter = {
  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/templates",
      summary: "List templates",
      description:
        "Templates this workspace published, with their active install count. Use the returned id with `templates.get`, `templates.getLink` or `templates.getAnalytics`.",
      tags: TAGS,
    })
    .output(z.object({ items: z.array(publicTemplateListItemResource) }))
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ context }) => ({
      items: (await templateService.list(context.workspace.id)).map((row) => ({
        ...toPublicTemplateBase(row),
        installCount: row.installCount,
      })),
    })),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/templates/{id}",
      summary: "Get template",
      description:
        "A template with the selection it was saved with. The frozen snapshot itself is never returned.",
      tags: TAGS,
    })
    .input(templateIdRequest)
    .output(publicTemplateResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) =>
      toPublicTemplate(
        await templateService.getDetailOrFail({
          workspaceId: context.workspace.id,
          templateId: input.id,
        }),
      ),
    ),

  create: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/templates",
      summary: "Create template",
      description:
        'Saves a snapshot of the selected resources. `selection` maps a category to `{mode: "all"}` or `{mode: "ids", ids}`; list the ids with `templates.listSelectableResources`. Add `lockedIds` (or `lockAll`) to make items view-only for installers. The template is private until `templates.updateShare` enables the link.',
      tags: TAGS,
    })
    .input(createTemplatePublicRequest)
    .output(publicTemplateResource)
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      const saved = await templateService.createOrUpdate({
        ...input,
        workspaceId: context.workspace.id,
        tenantId: context.workspace.tenantId,
        createdBy: null,
        actor: tokenActor(context),
      })
      return toPublicTemplate(
        await templateService.getDetailOrFail({
          workspaceId: context.workspace.id,
          templateId: saved.id,
        }),
      )
    }),

  update: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/templates/{id}",
      summary: "Update template",
      description:
        "Saves the template again and takes a new snapshot of the selected resources. Same body as `templates.create`.",
      tags: TAGS,
    })
    .input(updateTemplatePublicRequest)
    .output(publicTemplateResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const { id, ...values } = input
      await templateService.createOrUpdate({
        ...values,
        workspaceId: context.workspace.id,
        tenantId: context.workspace.tenantId,
        createdBy: null,
        existingTemplateId: id,
        actor: tokenActor(context),
      })
      return toPublicTemplate(
        await templateService.getDetailOrFail({
          workspaceId: context.workspace.id,
          templateId: id,
        }),
      )
    }),

  delete: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/templates/{id}",
      summary: "Delete template",
      description:
        "Deletes the template and its share link. Copies already installed stay where they are and stop being governed by it (their view-only locks are released).",
      tags: TAGS,
      successStatus: 204,
    })
    .input(templateIdRequest)
    .errors(possibleErrorsOnDeletingResource)
    .handler(async ({ context, input }) => {
      await templateService.softDelete({
        workspaceId: context.workspace.id,
        templateId: input.id,
        actor: tokenActor(context),
      })
    }),

  listSelectableResources: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/templates/selectable-resources",
      summary: "List selectable template resources",
      description:
        "Resources of one category that can go into a template, with ids for `selection.<category>.ids`. Page with `cursor`.",
      tags: TAGS,
    })
    .input(listSelectableResourcesPublicRequest)
    .output(publicSelectableResourcesResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(
      async ({ context, input }) =>
        await listSelectableResources({
          ...input,
          workspaceId: context.workspace.id,
          actor: tokenActor(context),
        }),
    ),

  previewDependencies: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/templates/dependencies-preview",
      summary: "Preview template selection dependencies",
      description:
        "Read only. Given the `selection` you would give `templates.create`, lists the resources that are included automatically because a selected one needs them (`includedDependencies`) and the tags, custom fields, folders and the like the template ships (`manifests`). Ids in `includedDependencies` are this workspace's; names come from `templates.listSelectableResources` for the same category.",
      tags: TAGS,
      spec: mcpSpec({ hitlPolicy: "none", readOnlyHint: true }),
    })
    .input(previewTemplateDependenciesPublicRequest)
    .output(templateDependenciesResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(
      async ({ context, input }) =>
        await previewTemplateDependencies({
          workspaceId: context.workspace.id,
          tenantId: context.workspace.tenantId,
          selection: input.selection,
          actor: tokenActor(context),
        }),
    ),

  listLockedResources: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/templates/locked-resources",
      summary: "Check which resources are view-only template copies",
      description:
        "Read only. Of the given ids of one resource kind, returns those installed from a view-only template: editing their content is refused with `templateAllowEditViolation`. Use it before editing a flow, keyword, trigger, sequence, AI agent, product or similar, with ids from that resource's own list operation.",
      tags: TAGS,
      spec: mcpSpec({ hitlPolicy: "none", readOnlyHint: true }),
    })
    .input(listLockedResourcesPublicRequest)
    .output(listLockedResourcesResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(
      async ({ context, input }) =>
        await listLockedTemplateResourceIds({
          workspaceId: context.workspace.id,
          resourceKind: input.resourceKind,
          resourceIds: input.resourceIds,
        }),
    ),

  getLink: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/templates/{id}/link",
      summary: "Get template share link",
      description:
        "The link to give installers. It only works while `shareEnabled` is true and before `shareExpiresAt`; turn it on with `templates.updateShare`.",
      tags: TAGS,
    })
    .input(templateIdRequest)
    .output(templateLinkResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await shareLink(
          context.workspace.id,
          await templateService.findByIdOrFail({
            workspaceId: context.workspace.id,
            templateId: input.id,
          }),
        ),
    ),

  updateShare: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/templates/{id}/share",
      summary: "Update template share link",
      description:
        "Turns the share link on or off and sets when it expires. Omit `expiresAt` to keep the current expiry, or pass `null` to remove it. Get the link itself from `templates.getLink`.",
      tags: TAGS,
    })
    .input(updateTemplateSharePublicRequest)
    .output(templateLinkResponse)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const template = await templateService.updateShareSettings({
        workspaceId: context.workspace.id,
        templateId: input.id,
        shareEnabled: input.enabled,
        shareExpiresAt: parseShareExpiry(input.expiresAt),
        actor: tokenActor(context),
      })
      return await shareLink(context.workspace.id, template)
    }),

  rotateShare: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/templates/{id}/share/rotate",
      summary: "Rotate template share link",
      description:
        "Issues a new link and invalidates every link shared before. The enabled switch and expiry are unchanged.",
      tags: TAGS,
    })
    .input(templateIdRequest)
    .output(templateLinkResponse)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await shareLink(
          context.workspace.id,
          await templateService.rotateShareToken({
            workspaceId: context.workspace.id,
            templateId: input.id,
            actor: tokenActor(context),
          }),
        ),
    ),

  listInstallers: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/templates/{id}/installers",
      summary: "List template installers",
      description:
        "The workspaces that installed this template, one row per installer however many copies they hold: name, install counts, the oldest version they run and whether they follow auto-update. No workspace ids are exposed; `publisherRef` is an opaque reference. Page with `cursor`.",
      tags: TAGS,
    })
    .input(listTemplateInstallersPublicRequest)
    .output(listTemplateInstallersPublicResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await templateService.listPublisherInstallations({
          workspaceId: context.workspace.id,
          templateId: input.id,
          actor: tokenActor(context),
          search: input.search,
          cursor: input.cursor,
          limit: input.limit,
        }),
    ),

  previewUninstallInstaller: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/templates/{id}/installers/{installerId}/uninstall-preview",
      summary: "Preview installer uninstall",
      description:
        "What `templates.uninstallInstaller` would do to one installer's copies, as counts, without doing it. Only possible when the installer allowed it (`eligibleForUninstall` in `templates.listInstallers`).",
      tags: TAGS,
      spec: mcpSpec({ readOnlyHint: true }),
    })
    .input(publisherInstallerRequest)
    .output(uninstallInstallerPublicResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await templateUninstallService.previewAsPublisher({
          workspaceId: context.workspace.id,
          templateId: input.id,
          publisherRef: input.installerId,
          actor: tokenActor(context),
        }),
    ),

  uninstallInstaller: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/templates/{id}/installers/{installerId}/uninstall",
      summary: "Uninstall template from installer",
      description:
        "Removes this template from one installer's workspace, if they allowed it. Only unmodified keywords it created are deleted; everything else stays with the installer, unlocked. Get `installerId` from the `publisherRef` of `templates.listInstallers`.",
      tags: TAGS,
    })
    .input(publisherInstallerRequest)
    .output(uninstallInstallerPublicResponse)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await templateUninstallService.uninstallAsPublisher({
          workspaceId: context.workspace.id,
          templateId: input.id,
          publisherRef: input.installerId,
          actor: tokenActor(context),
        }),
    ),

  getAnalytics: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/templates/{id}/analytics",
      summary: "Get template install figures",
      description:
        "Installation counts by status and how many follow auto-update. Aggregates only: installers' workspaces are not named.",
      tags: TAGS,
    })
    .input(templateIdRequest)
    .output(templateAnalyticsResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await templateService.getInstallAnalytics({
          workspaceId: context.workspace.id,
          templateId: input.id,
          actor: tokenActor(context),
        }),
    ),
}

const templatePreviewsPublicRouter = {
  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/template-previews/{id}",
      summary: "Preview shared template",
      description:
        "Whether the template behind a share link can be installed into this workspace, and what it contains. For an installable template, `collisions` predicts per tag, custom field, folder, product category, pipeline and inbox whether the install reuses, creates, renames or binds it, given what this workspace already has (`collisionSummary` counts them). `installable: false` carries a `reason` instead of an error. Install it with `templateInstallations.install`.",
      tags: INSTALLATION_TAGS,
      spec: mcpSpec({ readOnlyHint: true }),
    })
    .input(previewTemplatePublicRequest)
    .output(publicTemplatePreviewResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const actor = tokenActor(context)
      const preview = await templateInstallationRequestService.preview({
        shareToken: input.id,
        targetWorkspaceId: context.workspace.id,
        actor,
      })
      if (!preview.installable) {
        return preview
      }
      const { collisions, summary } = await previewInstallCollisionsForShare({
        shareToken: input.id,
        targetWorkspaceId: context.workspace.id,
        actor,
      })
      return {
        installable: true as const,
        template: {
          name: preview.template.name,
          description: preview.template.description,
          imageUrl: preview.template.imageUrl,
          publisherName: preview.template.publisherName,
          youtubeVideoId: preview.template.youtubeVideoId,
          testLink: preview.template.testLink,
          categoryCounts: preview.template.categoryCounts,
        },
        requiredInboxes: preview.requiredInboxes,
        requiredChannels: preview.requiredChannels,
        collisions,
        collisionSummary: summary,
        existingInstallation: preview.existingInstallation,
      }
    }),
}

const templateInstallationsPublicRouter = {
  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/template-installations",
      summary: "List template installations",
      description:
        "Templates installed into this workspace, newest first. Page with `cursor`; `activeOnly` returns just the installs still running.",
      tags: INSTALLATION_TAGS,
    })
    .input(listInstallationsPublicRequest)
    .output(listInstallationsPublicResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ context, input }) => {
      const page = await templateService.listInstallationsPage({
        workspaceId: context.workspace.id,
        status: input.status,
        activeOnly: input.activeOnly,
        beforeId: input.cursor,
        limit: input.limit,
      })
      return {
        items: page.items.map(
          ({ activeSync: _activeSync, uninstalledByKind, ...item }) => ({
            ...item,
            uninstalledBy: uninstalledByKind,
          }),
        ),
        nextCursor: page.nextCursor,
      }
    }),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/template-installations/{id}",
      summary: "Get template installation",
      description:
        "Status, failure code, warnings (grouped in `warningSummary`) and counts of one installation. Poll this after `templateInstallations.install` until the status is `completed`, `partial` or `failed`.",
      tags: INSTALLATION_TAGS,
    })
    .input(installationIdRequest)
    .output(installationDetailResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await templateInstallationRequestService.getDetail({
          workspaceId: context.workspace.id,
          installationId: input.id,
        }),
    ),

  install: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/template-installations",
      summary: "Install shared template",
      description:
        "Installs the template behind a share link into this workspace (same tenant only). Returns at once; the copy is made in the background, so follow it with `templateInstallations.get`. A template already installed here is updated in place to the newest version (the response then carries `syncId`) unless `allowDuplicate` is true, which installs a separate copy. Check the link first with `templatePreviews.get`.",
      tags: INSTALLATION_TAGS,
      successStatus: 202,
    })
    .input(installTemplatePublicRequest)
    .output(installTemplatePublicResponse)
    .errors(possibleErrorsOnCreatingResource)
    .handler(
      async ({ context, input }) =>
        await requestTemplateInstall({
          shareToken: input.shareToken,
          targetWorkspaceId: context.workspace.id,
          installedBy: null,
          actor: tokenActor(context),
          allowDuplicate: input.allowDuplicate,
          autoUpdate: input.autoUpdate,
          acceptPublisherUninstall: input.acceptPublisherUninstall,
          inboxBindings: input.inboxBindings,
        }),
    ),

  retry: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/template-installations/{id}/retry",
      summary: "Retry failed installation",
      description:
        "Queues a `failed` installation again. Any other status answers an error.",
      tags: INSTALLATION_TAGS,
      successStatus: 202,
    })
    .input(installationIdRequest)
    .output(installTemplatePublicResponse)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const installation = await templateInstallationRequestService.retry({
        workspaceId: context.workspace.id,
        installationId: input.id,
        actor: tokenActor(context),
        retriedBy: null,
      })
      await enqueueInstall(installation.id, installation.workspaceId)
      return { installationId: installation.id }
    }),

  listResources: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/template-installations/{id}/resources",
      summary: "List installation resources",
      description:
        "The resources the installation created or reused, with display names and whether they are view-only. Page with `cursor`.",
      tags: INSTALLATION_TAGS,
    })
    .input(listInstallationResourcesRequest)
    .output(listInstallationResourcesResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await templateInstallationRequestService.listResources({
          workspaceId: context.workspace.id,
          installationId: input.id,
          cursor: input.cursor,
          limit: input.limit,
        }),
    ),

  update: workspaceTokenAuthAPI
    .route({
      method: "PATCH",
      path: "/v1/template-installations/{id}",
      summary: "Update installation settings",
      description:
        "Turns auto-update on or off for one installed copy. While it is on, every save of the template that changes its contents brings this copy up to date.",
      tags: INSTALLATION_TAGS,
    })
    .input(updateInstallationPublicRequest)
    .output(z.object({ ok: z.boolean() }))
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      if (input.publisherUninstallGrant !== undefined) {
        await templateSyncRequestService.setPublisherUninstallGrant({
          workspaceId: context.workspace.id,
          installationId: input.id,
          actor: tokenActor(context),
          granted: input.publisherUninstallGrant,
        })
      }
      if (input.autoUpdate !== undefined) {
        await templateSyncRequestService.setAutoUpdate({
          workspaceId: context.workspace.id,
          installationId: input.id,
          actor: tokenActor(context),
          autoUpdate: input.autoUpdate,
        })
      }
      return { ok: true }
    }),

  sync: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/template-installations/{id}/sync",
      summary: "Sync installation to newest template version",
      description:
        "Brings an installed copy up to the template's newest version. Copies the installer edited are backed up first and then overwritten (`templateInstallations.restoreBackup` puts an edit back); view-only copies are overwritten. Returns at once; follow it with `templateInstallations.getSync`. A sync already running is returned instead of starting another. Check `updateAvailable` on `templateInstallations.get`.",
      tags: INSTALLATION_TAGS,
      successStatus: 202,
    })
    .input(syncInstallationPublicRequest)
    .output(syncInstallationPublicResponse)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const requested = await templateSyncRequestService.request({
        workspaceId: context.workspace.id,
        installationId: input.id,
        actor: tokenActor(context),
        trigger: "manual",
      })
      await enqueueSync(requested.syncId, requested.workspaceId)
      return { syncId: requested.syncId }
    }),

  listSyncs: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/template-installations/{id}/syncs",
      summary: "List installation syncs",
      description:
        "The newest syncs of one installation (automatic, manual and reinstall), newest first.",
      tags: INSTALLATION_TAGS,
    })
    .input(installationIdRequest)
    .output(listSyncsPublicResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => ({
      items: (
        await templateSyncRequestService.list({
          workspaceId: context.workspace.id,
          installationId: input.id,
        })
      ).map(toSyncSummary),
    })),

  getSync: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/template-installations/{id}/syncs/{syncId}",
      summary: "Get installation sync",
      description:
        "One sync: its status, the versions it moved between, counts, warnings, and the backups of edited copies it overwrote. Poll after `templateInstallations.sync`.",
      tags: INSTALLATION_TAGS,
    })
    .input(getSyncPublicRequest)
    .output(getSyncPublicResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const { sync, backups } = await templateSyncRequestService.getDetail({
        workspaceId: context.workspace.id,
        installationId: input.id,
        syncId: input.syncId,
      })
      return {
        ...toSyncSummary(sync),
        warnings: sync.warnings.map((warning) => ({
          category: warning.category,
          code: warning.entityKind,
          path: warning.path,
          value: warning.value,
        })),
        backups: backups.map((backup) => ({
          id: backup.id,
          resourceKind: backup.resourceKind,
          resourceId: backup.resourceId,
          byteSize: backup.byteSize,
        })),
      }
    }),

  previewUninstall: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/template-installations/{id}/uninstall-preview",
      summary: "Preview installation uninstall",
      description:
        "What `templateInstallations.uninstall` would do, as counts, without doing it: unmodified keywords are deleted; edited copies, shared tags and fields, and every other kind are kept and unlocked.",
      tags: INSTALLATION_TAGS,
      spec: mcpSpec({ readOnlyHint: true }),
    })
    .input(installationIdRequest)
    .output(uninstallInstallationPublicResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(
      async ({ context, input }) =>
        await templateUninstallService.previewAsInstaller({
          workspaceId: context.workspace.id,
          installationId: input.id,
          actor: tokenActor(context),
        }),
    ),

  uninstall: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/template-installations/{id}/uninstall",
      summary: "Uninstall template",
      description:
        "Removes the template from this workspace. Only unmodified keywords it created are deleted; everything else stays, no longer view-only and no longer updated by the template. Refused while a sync is running. Preview it with `templateInstallations.previewUninstall`.",
      tags: INSTALLATION_TAGS,
    })
    .input(installationIdRequest)
    .output(uninstallInstallationPublicResponse)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await templateUninstallService.uninstallAsInstaller({
          workspaceId: context.workspace.id,
          installationId: input.id,
          actor: tokenActor(context),
        }),
    ),

  restoreBackup: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/template-installations/{id}/backups/{backupId}/restore",
      summary: "Restore overwritten copy",
      description:
        "Puts back what a sync overwrote on an edited copy. Flows are restored into the draft only; publish them yourself. Refused while a sync of the installation is running.",
      tags: INSTALLATION_TAGS,
    })
    .input(restoreBackupPublicRequest)
    .output(z.object({ ok: z.boolean() }))
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      await templateSyncExecuteService.restoreBackup({
        workspaceId: context.workspace.id,
        installationId: input.id,
        backupId: input.backupId,
        actor: tokenActor(context),
      })
      return { ok: true }
    }),
}

const toSyncSummary = (sync: {
  id: string
  status: z.infer<typeof templateSyncStatusesSchema>
  trigger: z.infer<typeof templateSyncTriggersSchema>
  requestedVersion: number
  fromVersion: number | null
  appliedVersion: number | null
  errorCode: string | null
  counts: z.infer<typeof syncCountsSchema> | null
  createdAt: Date
  finishedAt: Date | null
}) => ({
  id: sync.id,
  status: sync.status,
  trigger: sync.trigger,
  requestedVersion: sync.requestedVersion,
  fromVersion: sync.fromVersion,
  appliedVersion: sync.appliedVersion,
  errorCode: sync.errorCode,
  counts: sync.counts,
  createdAt: sync.createdAt,
  finishedAt: sync.finishedAt,
})

export {
  templateInstallationsPublicRouter,
  templatePreviewsPublicRouter,
  templatesPublicRouter,
}
