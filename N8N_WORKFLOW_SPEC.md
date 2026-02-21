# N8N Workflow Specification: Marketing Contribution Percentage Calculation

This document specifies the workflow that needs to be implemented in n8n to calculate Marketing Contribution Percentage for HubSpot contacts.

## Webhook Payload

The webhook receives the following payload:
```json
{
  "portalId": 47955688,
  "action": "calculate_marketing_contribution"
}
```

## Workflow Steps

### 1. Extract Webhook Data
- Extract `portalId` from the webhook body
- Use `portalId` to look up HubSpot OAuth tokens (access_token and refresh_token) from your storage

### 2. Create/Verify Property
**API Endpoint:** `POST https://api.hubapi.com/crm/v3/properties/contacts`

**Request Body:**
```json
{
  "name": "marketing_contribution_percentage",
  "label": "Marketing Contribution Percentage",
  "type": "number",
  "fieldType": "number",
  "groupName": "contactinformation",
  "numberDisplayHint": "percentage",
  "options": []
}
```

**Note:** If the property already exists (you'll get a 409 error), skip this step and continue.

### 3. Get All Contacts
**API Endpoint:** `GET https://api.hubapi.com/crm/v3/objects/contacts`

Use pagination to get all contacts:
- Start with limit=100
- Use `after` parameter from response to get next page
- Continue until `paging.next` is null

**Required Headers:**
```
Authorization: Bearer {access_token}
```

### 4. Process Each Contact

For each contact, perform the following:

#### 4.1. Get Property History
**API Endpoint:** `GET https://api.hubapi.com/crm/v3/objects/contacts/{contactId}/properties/{propertyName}`

**With History:**
Use the Timeline Events API or Property History API:
- **Option 1 (Timeline):** `GET https://api.hubapi.com/crm/v3/timeline/events?objectId={contactId}&objectType=contact&eventType=propertyChange&propertyName=hs_latest_source`
- **Option 2 (Property History):** Use the HubSpot Private Apps API or check if you have access to property history endpoints

**Note:** HubSpot's API for property history may vary. You may need to:
- Use the timeline API to get property change events
- Or fetch contact timeline events and filter for `hs_latest_source` property changes

#### 4.2. Analyze Property History

Count changes and categorize:
1. Extract all values from the property history (including current value)
2. Count total number of changes (transitions between values)
3. Count how many values match these marketing sources:
   - `ORGANIC_SEARCH`
   - `PAID_SEARCH`
   - `EMAIL_MARKETING`
   - `SOCIAL_MEDIA`
   - `REFERRALS`
   - `OTHER_CAMPAIGNS`
   - `PAID_SOCIAL`
   - `AI_REFERRALS`

**Example:**
- Property history: `REFERRALS` → `OFFLINE` → `PAID_SEARCH` → `OFFLINE`
- Total changes: 3 (REFERRALS→OFFLINE, OFFLINE→PAID_SEARCH, PAID_SEARCH→OFFLINE)
- Marketing changes: 2 (REFERRALS and PAID_SEARCH)
- Percentage: (2/3) * 100 = 66.67%

**Important:** Count each unique value that appears, not transitions. So if the history shows:
- Initial: `REFERRALS`
- Changed to: `OFFLINE`
- Changed to: `PAID_SEARCH`
- Changed to: `OFFLINE`

The unique values are: `REFERRALS`, `OFFLINE`, `PAID_SEARCH`
Marketing values count: 2 (`REFERRALS`, `PAID_SEARCH`)
Total unique values: 3
Percentage: (2/3) * 100 = 66.67%

#### 4.3. Update Contact

**API Endpoint:** `PATCH https://api.hubapi.com/crm/v3/objects/contacts/{contactId}`

**Request Body:**
```json
{
  "properties": {
    "marketing_contribution_percentage": 66.67
  }
}
```

**Required Headers:**
```
Authorization: Bearer {access_token}
Content-Type: application/json
```

### 5. Handle Token Refresh

If you get a 401 error, refresh the access token:
- Use the refresh_token to get a new access_token
- Store the new tokens back in your storage
- Retry the failed request

## Implementation Notes

### Marketing Source Values
The following values should be counted as marketing contributions:
- `ORGANIC_SEARCH`
- `PAID_SEARCH`
- `EMAIL_MARKETING`
- `SOCIAL_MEDIA`
- `REFERRALS`
- `OTHER_CAMPAIGNS`
- `PAID_SOCIAL`
- `AI_REFERRALS`

### Property History Considerations

HubSpot's API for property history can be complex. Options include:

1. **Timeline Events API** (Recommended if available):
   - Query timeline events filtered by property name
   - Extract all property values from history
   - Current value can be fetched from the contact object itself

2. **Alternative Approach** (if history API is limited):
   - You may need to check if HubSpot provides property history in their CRM API
   - Some properties have version history, others may not be available

3. **Contact Timeline**:
   - Use contact timeline events to track property changes
   - Filter events by type and property name

### Error Handling

- Handle rate limiting (429 errors) with exponential backoff
- Handle token expiration (401 errors) with token refresh
- Log errors for contacts that fail processing
- Continue processing other contacts even if some fail

### Performance Considerations

- Process contacts in batches to avoid overwhelming the API
- Consider rate limits (typically 100 requests per 10 seconds for HubSpot)
- For large contact databases, consider processing during off-peak hours
- Store progress state in case the workflow needs to be resumed

## Required HubSpot Scopes

Ensure your OAuth tokens have these scopes:
- `crm.objects.contacts.read` - To read contact records
- `crm.objects.contacts.write` - To update contact records
- `crm.schemas.contacts.write` - **REQUIRED** - To create new contact properties
- `timeline` (optional, if using Timeline API for property history)

**Important:** If your existing OAuth tokens don't have the `crm.schemas.contacts.write` scope, you'll need to re-authorize the app to grant this permission. The app configuration has been updated to request this scope for new installations.

## Example n8n Workflow Structure

1. **Webhook Node** - Receive trigger
2. **Set Node** - Extract portalId and look up tokens
3. **HTTP Request Node** - Create property (handle 409 if exists)
4. **HTTP Request Node** - Get all contacts (with pagination loop)
5. **Split in Batches Node** - Process contacts in batches
6. **HTTP Request Node** - Get property history for each contact
7. **Function/Code Node** - Calculate percentage
8. **HTTP Request Node** - Update contact with calculated percentage
9. **Error Handling** - Log errors and continue

## Testing

Test with a small subset of contacts first to verify:
- Property creation works
- Property history retrieval works correctly
- Percentage calculation is accurate
- Contact updates succeed
