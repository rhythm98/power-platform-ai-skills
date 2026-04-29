---
name: migrate-sdm-to-edm
description: >-
  This skill should be used when the user asks to "migrate to enhanced data model",
  "migrate from standard to enhanced", "switch to EDM", "migrate SDM to EDM",
  "upgrade data model", "migrate site data model", or wants to migrate an existing
  Power Pages site from the Standard Data Model (SDM) to the Enhanced Data Model (EDM)
  using PAC CLI.
user-invocable: true
argument-hint: Optional site name or WebSiteId GUID
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

# Migrate Power Pages Site from Standard to Enhanced Data Model

Guide the user through a comprehensive migration of an existing Power Pages site from the Standard Data Model (SDM) to the Enhanced Data Model (EDM). This skill implements a multi-phase approach with environment-aware decision making, automatic dependency validation, customization analysis, and environment-specific remediation strategies (ALM-aware for Test/UAT/Prod).

> **Important:** This is a preview feature. EDM migration behavior may change before GA.

## Core Principles

- **Environment-aware**: Tailor migration strategy based on Dev vs Test/UAT/Prod environment type
- **ALM-first for non-Dev**: In non-Dev environments, assume configuration via solution deployment; customization fixes come from Dev via ALM
- **Validate comprehensively**: Check CLI context, site discovery, dependencies, and templates before any execution
- **Confirm before executing**: Present all migration parameters and customization findings to user before proceeding
- **Track all operations**: Generate comprehensive reports documenting all commands, results, and fixes applied
- **Graceful failure**: Halt on blocking issues; guide user to support when needed

**Supported templates:** Starter layout 1–5, Application processing, Blank page, Program registration, Schedule and manage meetings, FAQ.

**Not migratable:** Community (D365), Customer Self Service Portal (D365), Employee Self Service Portal (D365), Partner Portal (D365) — these support new EDM creation but can't be migrated from SDM.

**Initial request:** $ARGUMENTS

---

## Phase 1: Establish CLI Context

**Goal**: Set up PAC CLI with correct version and establish authenticated connection to Dataverse

**Actions**:

1. **Create todo list** with all 11 phases (see [Progress Tracking](#progress-tracking) table)

2. **Check PAC CLI Installation**

   ```powershell
   pac --version
   ```

   - **If version >= 1.31.6**: Proceed to step 3.
   - **If not installed or version < 1.31.6**: Ask user:

     | Question | Header | Options |
     |----------|--------|---------|
     | PAC CLI is not installed or below v1.31.6. Would you like guidance on installation? | Install PAC CLI | Yes, guide me, I'll install manually |

     If "Yes, guide me": Provide OS-specific installation steps from <https://aka.ms/PowerPlatformCLI>

3. **Check Existing Authentication**

   ```powershell
   pac auth list
   pac auth who
   ```

   - **If authenticated**: Extract environment URL and ask user:

     | Question | Header | Options |
     |----------|--------|---------|
     | Current environment: `<ENV_URL>`. Is this correct for migration? | Confirm Env | Yes, correct, No, switch environment |

     - If "No": Run `pac auth select` to switch
     - If "Yes": Proceed

   - **If not authenticated**: Ask for environment URL and run:

     ```powershell
     pac auth create -u "<ENV_URL>"
     ```

4. **Inform About Requirements** (user must verify manually):
   - Role: System Administrator, Dynamics 365 Admin, or Power Platform Admin
   - Dataverse base portal package: 9.3.2307.x+
   - Power Pages Core package: 1.0.2309.63+
   - Environment mode: If admin mode, background operations must be enabled (warning only)

**Output**: PAC CLI installed/verified, authenticated to correct environment

---

## Phase 2: Identify Site Context

**Goal**: Determine target site from local website.yml or user input

**Actions**:

1. **Check for Local website.yml**

   Look for `website.yml` in current directory:

   ```powershell
   Test-Path .\website.yml
   ```

   If found, parse it and extract:
   - `adx_name` (site name)
   - `adx_websiteid` (site GUID)

   Ask user confirmation:

   | Question | Header | Options |
   |----------|--------|---------|
   | Found local website.yml for site: `<SITE_NAME>` (ID: `<WEBSITEID>`). Use this site? | Use Local Context | Yes, use this site, No, specify different site |

   - If "Yes": Use extracted values
   - If "No": Proceed to step 2

2. **Get Site Identification from User**

   If website.yml not found or user declined, ask:

   | Question | Header | Options |
   |----------|--------|---------|
   | Provide the site name or WebSiteId (GUID) for migration | Site ID | I'll paste the site name, I'll paste the WebSiteId |

   Store the provided value.

**Output**: Target site name and/or WebSiteId captured

---

## Phase 3: Site Discovery and Validate Data Model

**Goal**: Find the site in the environment and verify it's on SDM (not already EDM)

**Actions**:

1. **List All Sites**

   ```powershell
   pac pages list -v
   ```

   Parse output to extract all available sites with:
   - WebSiteId
   - Site Name (display name from Friendly Name, the part before " - ")
   - URL slug (from Friendly Name, the part after " - ")
   - Current ModelVersion (`Standard` or `Enhanced`)

   > **Note:** Template name is not included in `pac pages list` output. Template will be confirmed separately in step 4.

2. **Locate Target Site**

   Search the list for site matching user input (name or GUID):
   - If found: Extract WebSiteId, ModelVersion, and URL slug. Store all three for later phases.
   - If not found: Show list and ask user to confirm site name/ID. If still not found, stop and ask user to verify in Power Platform admin center.

3. **Validate Data Model**

   Check `ModelVersion` from output:
   - **If EDM**: Stop with message: "This site is already on Enhanced Data Model. Migration not needed."
   - **If SDM**: Continue to Phase 4

4. **Identify Site Template**

   Template name is not available from `pac pages list`. Ask user to confirm their site's template:

   | Question | Header | Options |
   |----------|--------|---------|
   | What template is this site based on? | Site Template | Starter layout 1, Starter layout 2, Starter layout 3, Starter layout 4, Starter layout 5, Application processing, Blank page, Program registration, Schedule and manage meetings, FAQ, Other/Unknown |

   - If a supported template: Store template name and continue.
   - If "Other/Unknown": Check if it matches a non-migratable D365 portal (Community, Customer Self Service, Employee Self Service, Partner Portal). If so, stop with message: "This template cannot be migrated from SDM to EDM." Otherwise proceed with caution.

**Output**: Target site confirmed as SDM, template confirmed by user, ModelVersion and URL slug captured

---

## Phase 4: Validate Required Dependencies

**Goal**: Verify required packages are installed in environment

**Actions**:

1. **Check Installed Solutions**

   Run the following to list all solutions in the environment:

   ```powershell
   pac solution list
   ```

   Search the output for:
   - `MicrosoftCRMPortalBase` — Dataverse base portal package (required: 9.3.2307.x+)
   - `PowerPagesCore` — Power Pages Core package (required: 1.0.2309.63+)

   Present the found versions to the user.

2. **Evaluate Results**

   - **Both found and versions meet requirements**: Inform user and proceed to Phase 5.
   - **One or both not found**: Stop with message: "Required packages are not installed. Please install them from Power Platform admin center > Manage > Dynamics 365 apps before proceeding."
   - **Found but version too low**: Show current vs required version and stop with upgrade guidance.
   - **`pac solution list` fails or output is unclear**: Fall back to asking the user:

   | Question | Header | Options |
   |----------|--------|---------|
   | Unable to verify packages automatically. Can you confirm both Dataverse base portal package (9.3.2307.x+) and Power Pages Core (1.0.2309.63+) are installed? | Deps Confirmed | Yes, confirmed, Not sure — help me check |

   - If "Not sure": Guide user to Power Platform admin center > Solutions to verify package versions.
   - If "Yes": Proceed to Phase 5.

**Output**: Required package versions verified (Dataverse base portal 9.3.2307.x+, Power Pages Core 1.0.2309.63+)

---

## Phase 5: Validate Site Template and V2 Package

**Goal**: Ensure EDM-compatible template solution exists for the target site

**Actions**:

1. **Identify Template Requirements**

   Based on template extracted in Phase 3:
   - Some templates (Program Registration, Schedule and Manage Meetings) require specific EDM-compatible solutions
   - Inform user which V2 packages are needed

2. **Prompt About V2 Solution Availability**

   | Question | Header | Options |
   |----------|--------|---------|
   | Does your environment have EDM-compatible solution for template `<TEMPLATE_NAME>`? | V2 Package | Yes, installed, Not sure — try and see, Need to install it |

   - If "Need to install": Guide user to create a dummy site using same template in EDM-enabled environment (this installs the V2 packages)
   - If "Not sure": Continue and migration will warn if missing
   - If "Yes": Proceed to Phase 6

3. **Verify PowerPages_Core Installation**

   Check if `PowerPages_Core` application is installed. If missing, ask:

   | Question | Header | Options |
   |----------|--------|---------|
   | PowerPages_Core application is not installed. Should I install it now? | Install Core | Yes, install, No, skip |

   If "Yes":
   ```powershell
   pac application install --application-name "PowerPages_Core"
   ```

   Wait for completion or failure.

**Output**: V2 packages verified/installed, PowerPages_Core available

---

## Phase 6: Determine Environment Type and Migration Mode

**Goal**: Decide on ALM strategy and migration data mode based on environment

**Actions**:

1. **Identify Environment Type**

   | Question | Header | Options |
   |----------|--------|---------|
   | Which type of environment is this? | Environment Type | Development (Dev), Test/UAT, Production (Prod) |

   Store the choice.

2. **For Test/UAT/Prod: Ask About ALM Strategy**

   If Test/UAT/Prod selected:

   | Question | Header | Options |
   |----------|--------|---------|
   | Have you already migrated this site in Dev and want to use ALM to deploy fixes? Or do you want to do a fresh migration? | ALM vs Fresh | Use ALM deployment (fixes from Dev), Fresh migration (generate new report) |

   - If "Use ALM": Store ALM strategy. Skip Phase 7 (customization report) and proceed directly to Phase 8.
   - If "Fresh": Store Fresh strategy. Proceed to Phase 7.

3. **Recommend Migration Mode Based on Environment**

   - **Dev**: Recommend `configurationData` mode (full metadata + config)
   - **Test/UAT/Prod + ALM**: Recommend `configurationDataReferences` only (assume config deployed via solution)
   - **Test/UAT/Prod + Fresh**: Recommend `configurationData`

4. **Confirm Migration Mode**

   Show recommendation with explanation:

   | Question | Header | Options |
   |----------|--------|---------|
   | Recommended migration mode for `<ENV_TYPE>`: `<MODE>`. Details: `<EXPLANATION>`. Proceed? | Migration Mode | Yes, use recommended mode, No, let me choose a different mode |

   If "No", show all three modes with descriptions and allow selection:
   - `configurationData`: Migrate the metadata for the website. More information: List of tables to store configuration data.
   - `configurationDataReferences`: Migrate the transactional data for the website. More information: List of tables to store nonconfiguration data.
   - `all`: Migrate both configuration metadata and transactional data.

   Store final selected mode.

**Output**: Environment type determined, migration mode selected, ALM strategy decided

---

## Phase 7: Generate Customization Report

> **Skip this phase** if the ALM deployment strategy was selected in Phase 6. Proceed directly to Phase 8.

**Goal**: Download and analyze current customizations on the SDM site

**Actions**:

1. **Run Customization Report Generation**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --siteCustomizationReportPath "./migration-report"
   ```

   This creates `./migration-report/SiteCustomization.csv`

2. **Parse Report**

   Read CSV and categorize findings:
   - Liquid contains adx references
   - Data Model Extension (custom columns on adx tables)
   - Plugins registered on adx entities
   - Custom workflows
   - Relationships between custom and adx tables
   - FetchXML with adx references

3. **Generate HTML Report**

   ```bash
   node scripts/generate-migration-reports.js \
     --customization-report "./migration-report/SiteCustomization.csv" \
     --site-name "<SITE_NAME>" \
     --website-id "<WEBSITE_ID>" \
     --output-dir "./migration-reports"
   ```

   This creates user-friendly HTML reports for review.

4. **Present Findings**

   Show summary of customizations found (by category) or "No customizations found" if clean.

**Output**: Customization report generated and analyzed

---

## Phase 8: Migrate Site Data Model

**Goal**: Execute the migration using PAC CLI with selected mode

**Actions**:

1. **Execute Migration Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --mode <SELECTED_MODE>
   ```

   Where `<SELECTED_MODE>` is one of: `configurationData`, `configurationDataReferences`, `all`

2. **Monitor Execution**

   - Display progress to user
   - If template warning appears, inform user that V2 packages may be missing and migration may not complete

3. **Check Status**

   Poll every 1 minute, up to a maximum of 30 attempts (30 minutes total):

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --checkMigrationStatus
   ```

   Possible statuses:
   - **Complete/Success**: Proceed to Phase 9.
   - **In Progress**: Inform user "Migration is running (attempt `<N>`/30). This can take time for large data volumes (5K records per batch). Next check in 1 minute..." and wait before checking again.
   - **Failed**: Stop polling. Show error and ask:

     | Question | Header | Options |
     |----------|--------|---------|
     | Migration encountered an error. How to proceed? | Migration Error | Retry migration, Skip to rollback, Stop and troubleshoot |

   **If still In Progress after 30 minutes**: Stop polling and inform user:

   > Migration is still running after 30 minutes. This is expected for large sites. Check status manually when ready:
   > ```powershell
   > pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --checkMigrationStatus
   > ```
   > Once status shows Complete, return and continue from Phase 9.

**Output**: Migration executed and completed successfully

---

## Phase 9: Update Data Model Version

**Goal**: Activate EDM and deactivate SDM for the site

**Actions**:

1. **Retrieve Portal ID**

   PAC CLI does not expose Portal ID directly. Construct the site URL using values collected in earlier phases:

   - URL slug: captured from `pac pages list -v` Friendly Name (the part after " - ") in Phase 3
   - Cloud domain: from `pac auth who` cloud field (captured in Phase 1)

   | Cloud | Domain |
   |-------|--------|
   | Public | `powerappsportals.com` |
   | UsGov | `powerappsportals.us` |
   | UsGovHigh | `high.powerappsportals.us` |
   | UsGovDod | `appsplatform.us` |
   | China | `powerappsportals.cn` |

   Constructed URL: `https://<URL_SLUG>.<CLOUD_DOMAIN>`

   > **If the site uses a custom domain**, the constructed URL may not work. Ask user to provide the site's base URL directly.

   Guide user to open: `<CONSTRUCTED_SITE_URL>/_services/about`

   The page returns JSON — the `portalId` field contains the value needed. Ask user to copy and provide it:

   | Question | Header | Options |
   |----------|--------|---------|
   | Open `<SITE_URL>/_services/about` and paste the `portalId` value from the JSON response | Portal ID | I'll paste the Portal ID |

   Store the Portal ID — it will also be needed for rollback in Phase 11.

2. **Execute Update Command**

   ```powershell
   pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --updateDatamodelVersion --portalId "<PORTAL_ID>"
   ```

3. **Confirm Switch**

   Inform user: "Data model updated. Site now uses Enhanced Data Model. SDM record has been deactivated."

**Output**: Portal ID captured, site switched to EDM

---

## Phase 10: Customization Remediation

**Goal**: Guide user through fixing customizations (Dev-specific) or use ALM deployment (Test/UAT/Prod)

**Actions**:

### If Dev Environment OR Fresh Migration

If customizations were found in Phase 7, present remediation guidance:

**For Liquid references to adx tables:**
- Replace `entities['adx_webpage']` with `page` or `page.adx_*` where available
- Use `powerpagecomponent` table with type filters for complex queries
- Reference component type mapping table

**For Data Model Extensions (custom columns on adx tables):**
- Create new tables in Data workspace (e.g., `contoso_webpage`)
- Add custom columns to new tables
- Migrate data from old columns
- Update Liquid/FetchXML to reference new tables

**For FetchXML with adx references:**
- Replace entity names with `powerpagecomponent`
- Add filter on `powerpagecomponenttype` attribute
- Reference component type mapping table

**For Plugins/Workflows on adx tables:**
- Refactor to target `powerpagecomponent` (logical name)
- Update attribute references
- Re-register on new table

**Execute Automated Fixes** (if safe):

```bash
node scripts/generate-migration-reports.js \
  --site-name "<SITE_NAME>" \
  --website-id "<WEBSITE_ID>" \
  --portal-id "<PORTAL_ID>" \
  --siteCustomizationReportPath "./migration-report/SiteCustomization.csv" \
  --env-url "https://org.crm.dynamics.com" \
  --automate \
  --environment-type "dev" \
  --output-dir "./migration-reports"
```

Script will:
- Identify safe fixes (string attribute creation)
- Apply via Dataverse API
- Log all operations in execution report

### If Test/UAT/Prod + ALM Strategy

Skip customization fixes. Instead:

- Inform user: "Customization fixes should be applied in Dev environment first, then deployed via ALM/solution deployment"
- Guide user to use ALM deployment skill to bring fixes from Dev
- Do not generate fixes report in this environment

**Output**: Remediation guidance provided (Dev) or ALM deployment acknowledged (Test/UAT/Prod)

---

## Phase 11: Post-Migration Validation and Summary

**Goal**: Validate migrated site and summarize results

**Actions**:

1. **Present Validation Checklist**

   > **Post-Migration Validation:**
   > - [ ] Browse all site pages for rendering issues
   > - [ ] Test forms and data operations
   > - [ ] Test web API calls
   > - [ ] Test authentication flows
   > - [ ] Verify web roles and permissions
   > - [ ] Test customization-affected pages
   > - [ ] Run functional smoke tests

2. **Get Validation Status**

   | Question | Header | Options |
   |----------|--------|---------|
   | Did validation pass without issues? | Validation | Yes, all good, Issues found — rollback needed |

   - If "Issues found":

     Confirm the Portal ID collected in Phase 9 is still correct before proceeding:

     | Question | Header | Options |
     |----------|--------|---------|
     | Confirm Portal ID for rollback: `<PORTAL_ID>` (from Phase 9). Is this correct? | Confirm Portal ID | Yes, proceed with rollback, No, let me re-enter it |

     If "No": Ask user to re-open `<SITE_URL>/_services/about` and provide the correct Portal ID.

     ```powershell
     pac pages migrate-datamodel --webSiteId "<WEBSITE_ID>" --revertToStandardDataModel --portalId "<PORTAL_ID>"
     ```

     Inform user: "Site reverted to SDM. EDM record deactivated, SDM record reactivated."

   - If "Yes": Present success summary

3. **Success Summary**

   > **Migration Complete**
   > - Site: `<SITE_NAME>` (ID: `<WEBSITEID>`)
   > - Previous model: Standard (SDM)
   > - Current model: Enhanced (EDM)
   > - Customizations requiring fixes: `<COUNT>` (or "None")
   > - Environment: `<ENV_TYPE>`
   > - Reports available in: `./migration-reports/`

4. **Record Skill Usage**

   Follow instructions in `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

**Output**: Site validated, migration complete (or rolled back), reports generated

---

## Progress Tracking

| Phase | Task Subject | Active Form |
|-------|-------------|-------------|
| Phase 1 | Establish CLI context | Establishing CLI context |
| Phase 2 | Identify site context | Identifying site context |
| Phase 3 | Site discovery and validation | Discovering and validating site |
| Phase 4 | Validate dependencies | Validating dependencies |
| Phase 5 | Validate template and V2 package | Validating template and V2 package |
| Phase 6 | Determine environment and migration mode | Determining environment and migration mode |
| Phase 7 | Generate customization report (Dev/Fresh only) | Generating customization report |
| Phase 8 | Execute migration | Executing migration |
| Phase 9 | Update data model version | Updating data model version |
| Phase 10 | Remediate customizations | Remediating customizations |
| Phase 11 | Validate and complete | Validating and completing migration |

---

## Component Type Reference

Use this for FetchXML and Liquid customization mapping:

| Component | Type Value |
|-----------|------------|
| Publishing State | 1 |
| Web Page | 2 |
| Web File | 3 |
| Web Link Set | 4 |
| Web Link | 5 |
| Page Template | 6 |
| Content Snippet | 7 |
| Web Template | 8 |
| Site Setting | 9 |
| Web Page Access Control Rule | 10 |
| Web Role | 11 |
| Website Access | 12 |
| Site Marker | 13 |
| Basic Form | 15 |
| Basic Form Metadata | 16 |
| List | 17 |
| Table Permission | 18 |
| Advanced Form | 19 |
| Advanced Form Step | 20 |
| Advanced Form Metadata | 21 |
| Poll Placement | 24 |
| Ad Placement | 26 |
| Bot Consumer | 27 |
| Column Permission Profile | 28 |
| Column Permission | 29 |
| Redirect | 30 |
| Publishing State Transition Rule | 31 |
| Shortcut | 32 |
| Cloud Flow | 33 |
| UX Component | 34 |
