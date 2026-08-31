# Business Voice AI

Yes. **Now I understand the product correctly.** The screenshots are not the product you want to copy literally; they show the **client-facing SaaS dashboard experience** you want.

Your actual product is:

> **Customer pays → creates/logs into their own business account → selects business type → fills in business information, rules, services, FAQs, hours, pricing, voice/language, phone number, etc. → your backend converts that configuration into the AI agent's instructions/context → Sarvam handles the conversational intelligence + speech → the customer's phone number receives calls → the agent answers as that customer's business.**

And one important correction: **the customer's data is not "training" Sarvam's model.** You're dynamically configuring/grounding the agent with that business's information. That is much faster and cheaper than actually training a model.

Sarvam currently supports Voice Agents, telephony connections/numbers, variables, tools, multilingual voice, and agent configuration; its API stack also provides Saaras STT, Sarvam conversational LLMs, and Bulbul v3 TTS. ([Sarvam AI Developer Documentation][1])

Below is the prompt I would give Lovable.

---

# MASTER LOVABLE PROMPT

Copy everything below into Lovable.

```text

Build a production-grade multi-tenant SaaS platform for AI-powered business phone agents.

IMPORTANT:

This is NOT an admin dashboard for my company.

This is a CUSTOMER-FACING SaaS dashboard.

Each customer/business owner creates their own account after purchasing a subscription. They log into their own isolated workspace. They select their business type, enter their business information, configure their AI receptionist/voice agent, connect or purchase a phone number, and then the AI agent answers calls on behalf of that business.

The core product is:

CUSTOMER

↓

SIGN UP / LOGIN

↓

SUBSCRIPTION / PAYMENT

↓

CREATE BUSINESS

↓

SELECT BUSINESS TYPE

↓

FILL BUSINESS INFORMATION

↓

CONFIGURE AI AGENT

↓

CHOOSE LANGUAGE + VOICE

↓

CONNECT / BUY PHONE NUMBER

↓

ACTIVATE AGENT

↓

CUSTOMERS CALL THE NUMBER

↓

TELEPHONY

↓

SARVAM AI

↓

STT → LLM → TTS

↓

AI SPEAKS AS THE CUSTOMER'S BUSINESS

↓

CALL DATA / TRANSCRIPT / SUMMARY / LEAD

↓

CUSTOMER SEES EVERYTHING IN THEIR DASHBOARD

Do NOT build fake buttons.

Every button, form, toggle, tab, dropdown, search, filter, modal, save action, delete action, pagination control, export button and navigation item must actually work.

Use realistic loading states, success states, error states, empty states and confirmation dialogs.

Do not use placeholder lorem ipsum.

Do not create fake AI functionality.

If a backend integration is not yet configured, create the correct backend abstraction/interface and clearly show a "Not connected" state rather than pretending that it works.

==================================================

1. PRODUCT POSITIONING

==================================================

The application should feel like a serious B2B SaaS product.

The user is a business owner.

Examples:

Dental clinic

Hotel

Restaurant

Real estate agency

Salon

Hospital

Clinic

Gym

Education institute

Car dealership

Travel agency

Law firm

Home services

E-commerce business

Local retail store

Property management

Other

The AI agent should behave as an employee/receptionist of that business.

The customer does NOT need to understand prompts, LLMs, APIs, STT, TTS, models, or technical configuration.

The customer fills business information through structured UI.

The system converts that information into the agent configuration automatically.

==================================================

2. MULTI-TENANT ARCHITECTURE

==================================================

Use Supabase for:

- Authentication

- PostgreSQL database

- Row Level Security

- Storage

- Realtime where appropriate

- Edge Functions/server-side functions where appropriate

Every customer must have an isolated workspace.

Never allow Customer A to access Customer B's:

- business data

- calls

- transcripts

- phone numbers

- leads

- recordings

- reservations

- agent configuration

- billing information

- API credentials

Database entities should include at minimum:

users

organizations

organization_members

subscriptions

businesses

business_types

business_hours

services

products

faqs

business_rules

offers

agent_configs

agent_versions

agent_variables

phone_numbers

telephony_connections

call_logs

call_recordings

call_transcripts

call_summaries

leads

customers

reservations

outbound_campaigns

campaign_contacts

messages

usage_records

credits

invoices

notifications

integrations

api_credentials

audit_logs

Use organization_id / tenant_id on all tenant-owned tables.

Enable Supabase Row Level Security.

==================================================

3. AUTHENTICATION

==================================================

Create:

/login

/signup

/forgot-password

/reset-password

/onboarding

Signup fields:

- Full name

- Business email

- Phone

- Password

- Business name

- Country

- Terms acceptance

Support:

- Email/password

- Google OAuth if available

- Email verification

- Password reset

- Logout

After successful signup:

If subscription is inactive:

→ show pricing/payment flow.

If subscription is active:

→ start onboarding.

==================================================

4. SUBSCRIPTION / PAYMENT GATE

==================================================

The customer should only unlock the actual dashboard after successful payment.

Create:

/pricing

/checkout

/billing

Show plans such as:

Starter

Professional

Business

DO NOT hard-code fake payment success.

Create payment abstraction so Razorpay/Stripe can be integrated.

For India, prioritize Razorpay.

Subscription state:

trial

active

past_due

cancelled

expired

suspended

Dashboard access:

active subscription → full dashboard

trial → allowed features based on trial

expired → read-only / billing screen

cancelled → retain data but disable agent deployment

==================================================

5. ONBOARDING

==================================================

Create a polished multi-step onboarding wizard.

STEP 1 — Business Type

"What type of business do you run?"

Cards:

Dental Clinic

Medical Clinic

Hotel

Restaurant

Real Estate

Salon

Gym

Education

Travel

Automotive

Legal

Home Services

Retail

E-commerce

Other

When selected, dynamically customize the next forms.

For example:

Dental clinic:

- Doctors

- Treatments

- Treatment prices

- Appointment duration

- Working hours

- Emergency policy

- Location

- Insurance

- Appointment rules

Hotel:

- Room types

- Room rates

- Check-in/check-out

- Amenities

- Cancellation policy

- Availability

- Extra guest charges

- Breakfast

- Booking rules

Restaurant:

- Cuisine

- Menu

- Opening hours

- Reservation rules

- Seating

- Delivery

- Takeaway

- Special offers

Real estate:

- Properties

- Locations

- Prices

- Property types

- Availability

- Site visit scheduling

- Agent contact

Do not force every business into the same generic form.

==================================================

6. BUSINESS PROFILE

==================================================

Create a complete "About Your Business" page.

Fields:

Business name

Business description

Business category

Address

City

State

Country

PIN/ZIP

Website

Email

Primary phone

Secondary phone

WhatsApp

Google Maps URL

Instagram

Facebook

Business description textarea.

"How should the AI describe your business?"

Example:

"We are a dental clinic specializing in cosmetic dentistry, implants, root canal treatment and preventive care."

Allow 1500-3000 characters.

SAVE button must persist to database.

Auto-save can be enabled but also provide explicit Save.

==================================================

7. BUSINESS HOURS

==================================================

Create complete business-hours editor.

Days:

Monday

Tuesday

Wednesday

Thursday

Friday

Saturday

Sunday

Each day:

Open / Closed

Opening time

Closing time

Break periods

Support multiple intervals.

Example:

09:00 AM → 01:00 PM

02:00 PM → 07:00 PM

Timezone selector.

Holiday/closure dates.

Emergency availability.

These hours must be usable by the AI agent.

The agent must never claim the business is open when the configured hours say it is closed.

==================================================

8. SERVICES / PRODUCTS

==================================================

Create dynamic service/product management.

Each item:

Name

Description

Category

Price

Currency

Duration

Availability

Active/inactive

Special notes

Buttons:

+ Add service

Edit

Duplicate

Delete

Search

Filter

Sort

For healthcare:

Treatment

Price

Duration

Doctor

Preparation instructions

For hotels:

Room

Price

Capacity

Amenities

Availability

For restaurants:

Dish

Price

Category

Availability

Dietary tags

The UI should adapt based on business type.

==================================================

9. FAQs

==================================================

Create FAQ management.

Each FAQ:

Question

Answer

Category

Active/inactive

Examples:

"What time do you open?"

"Do you accept walk-ins?"

"How much does a root canal cost?"

"Do you provide home delivery?"

Buttons:

Add

Edit

Delete

Search

Reorder

FAQs become part of the agent knowledge/context.

==================================================

10. AI RECEPTIONIST / AGENT

==================================================

Create a major section:

AI Receptionist

Subsections:

Assistant

Voice

Answers

Rules

Knowledge

Variables

Tools

Testing

The user should NEVER need to write a system prompt manually unless they choose Advanced Mode.

==================================================

11. ASSISTANT CONFIGURATION

==================================================

Create:

Agent name

Example:

"Sarah"

Persona:

Friendly

Professional

Warm

Concise

Formal

Casual

Custom personality textarea.

Primary objective:

Answer questions

Book appointments

Take reservations

Capture leads

Provide pricing

Handle FAQs

Transfer to human

Take messages

Multi-select.

Create "What the AI knows" section.

Automatically generate a structured agent context from:

business profile

services

FAQs

business hours

pricing

rules

offers

locations

contact details

IMPORTANT:

Do NOT actually train a Sarvam model.

Instead create a versioned agent configuration.

Example:

agent_version:

v1

v2

v3

When business data changes:

1. Save business data

2. Generate normalized agent configuration

3. Generate system instructions/context

4. Validate configuration

5. Push/update the Sarvam agent/runtime configuration

6. Mark new version active

Keep previous versions for rollback.

==================================================

12. AGENT RULES

==================================================

Create "Rules & Restrictions".

Examples:

Always confirm appointment date and time.

Never invent prices.

Never promise availability without checking.

Never disclose private information.

Never provide medical diagnosis.

Transfer emergency calls to staff.

Ask for caller name and phone number.

Ask for appointment date before booking.

Never claim a booking succeeded unless the booking tool confirms it.

UI:

+ Add rule

Each rule:

textarea

priority

active toggle

delete

Allow 20+ rules.

==================================================

13. WHAT THE AGENT CAN DO

==================================================

Create capability toggles.

Examples:

Answer FAQs

Explain services

Quote prices

Check business hours

Capture lead

Collect customer information

Book appointments

Cancel appointment

Reschedule appointment

Check availability

Send confirmation

Send WhatsApp message

Send SMS

Transfer to human

Take callback request

Create reservation

Check order status

Create support ticket

Each capability must have:

toggle

description

connection status

If a capability requires an external integration:

show:

"Requires connection"

"Connect"

Do not pretend it is available.

==================================================

14. KNOWLEDGE

==================================================

Create Knowledge section.

Allow customer to add:

PDF

DOCX

TXT

CSV

Website URL

Plain text

FAQs

Example:

Pricing PDF

Menu

Service catalogue

Policy document

Store documents in Supabase Storage.

Create knowledge processing pipeline.

When documents are uploaded:

upload

extract

chunk

index

associate with organization/business

mark status

Statuses:

Processing

Ready

Failed

The agent should use this information when responding.

Do not send the entire document blindly in every prompt.

Create a knowledge retrieval abstraction so RAG can be added.

==================================================

15. VOICE CONFIGURATION

==================================================

Create beautiful voice selection UI.

Use Sarvam Bulbul v3.

Current supported languages include:

English — en-IN

Hindi — hi-IN

Bengali — bn-IN

Tamil — ta-IN

Telugu — te-IN

Gujarati — gu-IN

Kannada — kn-IN

Malayalam — ml-IN

Marathi — mr-IN

Punjabi — pa-IN

Odia — od-IN

Also support:

Auto Detect / multilingual

Voice list:

Male:

Shubh

Aditya

Rahul

Rohan

Amit

Dev

Ratan

Varun

Manan

Sumit

Kabir

Aayan

Ashutosh

Advait

Anand

Tarun

Sunny

Mani

Gokul

Vijay

Mohit

Rehan

Soham

Female:

Ritu

Priya

Neha

Pooja

Simran

Kavya

Ishita

Shreya

Roopa

Tanya

Shruti

Suhani

Kavitha

Rupali

Store speaker IDs lowercase.

Example:

shubh

ritu

simran

Voice cards:

Name

Gender

Language compatibility

Play preview button

Selected state

Settings:

Voice

Language

Speaking pace

Temperature if supported by the runtime

For Bulbul v3 pace range:

0.5x → 2.0x

Default:

1.0x

Never expose unsupported pitch/loudness controls for Bulbul v3.

==================================================

16. CALL GREETING

==================================================

Create:

"Call Greeting"

Example:

"Thank you for calling Smile Dental. This is Sarah. How may I help you today?"

The greeting should be configurable separately.

Support language-specific greetings.

English greeting

Hindi greeting

Telugu greeting

Tamil greeting

etc.

If multilingual mode is enabled, select appropriate greeting.

==================================================

17. PHONE NUMBERS

==================================================

This is critical.

Create:

Phone Numbers

Show:

Current number

Status

Assigned agent

Incoming calls

Outgoing calls

Country

Provider

Buttons:

+ Buy New Number

+ Connect Existing Number

Customer should be able to purchase another number/line.

Do NOT make this a fake UI.

Create telephony provider abstraction.

Support architecture for:

Sarvam rented number

Exotel

Twilio

Vobiz

Smartflo

Pulse

Intalk

The exact provider availability should be controlled by backend configuration.

Phone number lifecycle:

available

purchasing

active

assigned

suspended

released

Number can be assigned to an agent.

One agent may have multiple numbers.

One number should have one primary inbound agent.

==================================================

18. BUY NEW NUMBER FLOW

==================================================

When user clicks:

+ Buy New Number

Open modal/page.

Fields:

Country

State/Region if supported

Number type

Area code / prefix if supported

Search available numbers.

Results:

Phone number

Monthly price

Setup fee

Capabilities:

Voice

SMS

WhatsApp if supported

Button:

Buy

Then:

Payment

Provisioning

Assign to agent

Show provisioning status.

Never fake availability or pricing.

Backend must query the actual telephony provider.

==================================================

19. CONNECT EXISTING NUMBER

==================================================

Create:

Connect existing number

Provider selector:

Exotel

Twilio

Vobiz

Smartflo

Pulse

Intalk

Other

Credentials must be stored server-side securely.

Never expose credentials in frontend JavaScript.

Test connection button.

Show:

Connected

Failed

Needs attention

==================================================

20. LIVE CALL PIPELINE

==================================================

Architecture should support:

Caller

↓

Telephony Provider

↓

WebSocket / Media Stream

↓

Voice Agent Runtime

↓

Speech-to-Text

↓

Conversation Context

↓

Sarvam conversational LLM

↓

Tool / Knowledge retrieval

↓

Text-to-Speech

↓

Audio

↓

Caller

Use Sarvam services for:

STT:

Saaras v3 / realtime where appropriate

LLM:

sarvam-105b-conversations for conversational voice workloads

TTS:

Bulbul v3

For realtime calls, use streaming/realtime APIs rather than REST request/response for every sentence.

The backend must manage:

session_id

call_id

tenant_id

agent_id

phone_number_id

caller_number

language

start_time

end_time

duration

transcript

summary

disposition

lead information

==================================================

21. SARVAM API KEY SECURITY

==================================================

VERY IMPORTANT:

NEVER put SARVAM_API_KEY in the browser.

NEVER put it in React environment variables exposed to the frontend.

NEVER send it to the customer.

Use server-side environment variables:

SARVAM_API_KEY

All Sarvam requests must go through backend services.

Create:

SarvamService

with methods such as:

createAgentConfiguration()

updateAgentConfiguration()

testAgent()

generateSpeech()

transcribeAudio()

runConversation()

updateDeployment()

getUsage()

Keep provider-specific logic isolated.

==================================================

22. AGENT CONFIG GENERATION

==================================================

When customer saves business information:

Backend should generate a normalized agent configuration.

Example internal object:

{

  business_name,

  business_type,

  description,

  location,

  hours,

  services,

  prices,

  faq,

  rules,

  personality,

  greeting,

  language,

  voice,

  capabilities,

  escalation_rules

}

Then create an agent instruction structure.

Example:

PERSONA

You are the phone receptionist for {{business_name}}.

BUSINESS CONTEXT

{{business_description}}

SERVICES

{{services}}

BUSINESS HOURS

{{hours}}

RULES

{{rules}}

OBJECTIVES

{{objectives}}

ESCALATION

{{escalation_rules}}

IMPORTANT:

Only use information provided by the business configuration and connected tools.

Never invent information.

The actual prompt should be generated server-side.

Do not expose internal system instructions unnecessarily to customers.

==================================================

23. VERSIONING

==================================================

Every major agent configuration update creates a version.

Example:

Agent v1

Agent v2

Agent v3

Show:

Active version

Created date

Changes

Status

Actions:

View

Activate

Rollback

Before activating a new configuration:

Run validation.

Check:

Business name exists

Business type exists

Greeting exists

Language exists

Voice exists

At least one phone number exists

Business hours configured

Rules valid

==================================================

24. TEST AGENT

==================================================

Create a Test Agent page.

Two modes:

Text test

Voice test

Text:

Customer types:

"How much is a root canal?"

Agent responds.

Voice:

Browser microphone

↓

Realtime connection

↓

agent

↓

audio response

Show conversation transcript.

Display:

User

Agent

Also show:

Detected language

Latency

Tools called

Knowledge source used

DO NOT require the user to call their production number just to test the agent.

==================================================

25. CALLS PAGE

==================================================

Match the screenshot concept.

Columns:

Date/time

Caller

Direction

Phone number

Duration

Language

Outcome

Lead score

Summary

Recording

Status

Filters:

Incoming

Outgoing

Missed

Answered

Transferred

Failed

Search by:

Name

Phone

Summary

Click call → detailed call page.

Detailed page:

Caller information

Call recording

Transcript

Summary

Duration

Detected language

Agent version

Phone number

Call outcome

Lead information

Actions

Actions:

Play recording

Download recording

Export transcript

Create lead

Call back

Add note

==================================================

26. MESSAGES

==================================================

Create unified message inbox.

Channels:

Website

WhatsApp

Instagram

SMS

Other supported integrations

Tabs:

All

Needs attention

Active

Closed

Each conversation:

Customer

Last message

Channel

Status

Timestamp

Agent summary

Conversation view:

Messages

Customer details

Agent details

Actions

If a channel is not connected:

show:

"Connect channel"

Do not fake incoming messages.

==================================================

27. LEADS

==================================================

Create CRM-like Leads page.

Columns:

Name

Phone

Email

Source

Asked about

Score

Status

Last call

Created

Assigned

Statuses:

New

Contacted

Qualified

Converted

Lost

Lead score:

Cold

Warm

Hot

Lead detail:

Contact information

Conversation history

Calls

Messages

Notes

Requested service

AI summary

Next action

Actions:

Call

Message

Change status

Add note

Export

==================================================

28. CUSTOMERS / GUESTS

==================================================

Depending on business type call this:

Customers

Guests

Patients

Clients

Use dynamic terminology.

Store:

Name

Phone

Email

Last interaction

Calls

Bookings

Messages

Notes

Customer detail page.

==================================================

29. OUTBOUND CALLS

==================================================

Create:

Outbound Calls

Show:

Campaigns

Contacts

Call history

Calling hours

Concurrency

Create campaign.

Fields:

Campaign name

Purpose

Phone number

Contact list

Script / objective

Start time

End time

Max attempts

Retry policy

Calling window

Agent

Important compliance section.

For India:

Display clear compliance warning and require the customer to confirm lawful calling practices.

Do not automatically call arbitrary scraped numbers.

Support only contacts the customer is authorized to call.

==================================================

30. RESERVATIONS

==================================================

Create reservation management.

For businesses that need bookings:

Reservations

Calendar

Availability

Reservation:

Customer

Phone

Date

Time

Service

Staff

Duration

Status

Notes

Statuses:

Pending

Confirmed

Cancelled

Completed

No-show

Agent can create a reservation only if connected availability/tool confirms it.

==================================================

31. CALENDAR

==================================================

Calendar views:

Day

Week

Month

Appointments displayed.

Click appointment:

Customer

Service

Time

Staff

Notes

Status

Allow:

Create

Edit

Cancel

Reschedule

==================================================

32. ROOMS / RESOURCES

==================================================

For hotels or businesses with resources.

Create dynamic resource management.

Hotels:

Room types

Rooms

Capacity

Pricing

Availability

Clinics:

Doctors

Rooms

Appointment slots

Salons:

Staff

Services

Slots

Do not show irrelevant modules prominently for every business type.

==================================================

33. CHANNELS

==================================================

Create Channels section.

Channels:

Phone

Website

WhatsApp

Instagram

SMS

Email if supported

Each:

Connected / Not connected

Connect button.

Phone should be the primary channel for this MVP.

==================================================

34. MONEY / BILLING

==================================================

Create:

Wallet

Credits

Usage

Invoices

Subscription

Show:

Current balance

Estimated remaining minutes

This month's usage

AI usage

Telephony usage

Subscription

Usage breakdown:

STT

LLM

TTS

Telephony

Storage

Messages

Important:

Sarvam API costs are usage based.

Current Sarvam published pricing includes:

STT: ₹30/hour

STT with diarization: ₹45/hour

Bulbul v3 TTS: ₹30 per 10,000 characters

Sarvam 105B: ₹29.28 input / ₹10.98 cached input / ₹73.20 output per 1M tokens

Sarvam 105B Conversations has the same listed token pricing.

Use configurable pricing in the application.

DO NOT hard-code provider pricing into business logic.

Create:

provider_cost

customer_price

margin

This lets us add our own SaaS markup.

==================================================

35. SETTINGS

==================================================

Create Settings with:

Profile

Business

Team

Security

Notifications

Billing

Integrations

Phone

AI

Data & Privacy

Profile:

Name

Email

Phone

Password

Business:

Business name

Address

Timezone

Currency

Team:

Invite employee

Roles

Roles:

Owner

Admin

Manager

Staff

Viewer

Security:

Change password

Sessions

2FA architecture placeholder

Login history

Notifications:

New call

Missed call

New lead

Booking

Low credits

Agent error

Payment failure

==================================================

36. DATA RETENTION

==================================================

Allow settings:

Call recording enabled/disabled

Transcript enabled/disabled

Recording retention period

Data deletion

Provide:

Delete conversation

Delete recording

Export business data

Delete account

Do not permanently delete immediately without confirmation.

==================================================

37. DASHBOARD OVERVIEW

==================================================

Create a useful Overview page.

Cards:

Calls today

Answered calls

Missed calls

New leads

Appointments

Agent status

Current phone number

Usage

Credits

Charts:

Calls over time

Call duration

Lead conversion

Call outcomes

Usage

Agent status:

LIVE

PAUSED

NOT CONFIGURED

ERROR

Main CTA:

"Test your AI receptionist"

Secondary:

"Edit AI receptionist"

==================================================

38. SIDEBAR

==================================================

Use a navigation structure inspired by the screenshots but adapted for our product.

Sidebar:

Overview

Inbox

  Calls

  Messages

  Leads

Customers

Reservations

  Calendar

AI Receptionist

  Assistant

  Voice

  Knowledge

  Rules

  Tools

  Test Agent

Phone

  Numbers

  Buy Number

Outbound Calls

Channels

Usage & Billing

Settings

Hide irrelevant business modules when not applicable.

==================================================

39. UI / UX

==================================================

The UI should feel like a premium modern B2B SaaS.

Do NOT make it look AI-generated.

Do NOT use excessive gradients.

Do NOT use giant glowing AI circles.

Do NOT use cartoon robot graphics.

Do NOT use generic SaaS templates.

Use:

Dark professional interface

Black / charcoal background

Subtle borders

White typography

Muted gray secondary text

Single accent color

Compact cards

High information density

Rounded but not excessively rounded components

Strong spacing

Clear hierarchy

Professional tables

Desktop-first.

Responsive tablet/mobile.

Sidebar collapses on mobile.

Top navigation:

Business name

Agent status

Usage

Notifications

Profile

Use subtle animations only.

==================================================

40. IMPORTANT EMPTY STATES

==================================================

Every page needs useful empty states.

Example:

No calls yet

"Your AI receptionist hasn't received a call yet."

CTA:

Test your agent

No phone number:

"Your AI receptionist isn't connected to a phone number."

CTA:

Buy a number

No knowledge:

"Add your business documents so the assistant can answer with more context."

CTA:

Upload document

No leads:

"Leads captured by your AI receptionist will appear here."

==================================================

41. ERROR STATES

==================================================

Examples:

Sarvam API unavailable

Telephony disconnected

Insufficient credits

Invalid voice

Phone number provisioning failed

Agent configuration invalid

Knowledge processing failed

Payment failed

Show human-readable errors.

Never expose API secrets.

Provide Retry.

==================================================

42. REALTIME AGENT STATUS

==================================================

Show:

Agent status

LIVE

PAUSED

ERROR

DEPLOYING

When activating:

Preparing agent

Validating configuration

Connecting Sarvam

Connecting phone number

Running health check

LIVE

==================================================

43. BACKEND ARCHITECTURE

==================================================

Frontend:

React

TypeScript

Tailwind

shadcn/ui

Backend:

Supabase

PostgreSQL

Edge Functions / server API

Create service layer:

/services/auth

/services/business

/services/agent

/services/sarvam

/services/telephony

/services/calls

/services/leads

/services/reservations

/services/billing

/services/knowledge

/services/notifications

Sarvam integration must be isolated:

SarvamClient

Functions:

createAgent

updateAgent

publishAgent

testAgent

getAgent

generateTTS

transcribe

getUsage

If Sarvam's current public API does not expose a particular management operation needed by this SaaS, DO NOT invent an endpoint.

Create an adapter/interface and mark the operation as requiring the Sarvam Voice Agents/deployment API or custom runtime.

==================================================

44. RECOMMENDED REAL-TIME ARCHITECTURE

==================================================

For production phone calls:

Telephony provider

↓

WebSocket / media stream

↓

Voice runtime

↓

Realtime STT

↓

Conversation manager

↓

Sarvam conversational model

↓

Knowledge retrieval / tools

↓

Sarvam TTS streaming

↓

Telephony audio

Use streaming wherever possible.

Do not make:

phone → REST STT → REST LLM → REST TTS

for every conversational turn because latency will become unacceptable.

==================================================

45. TOOL SYSTEM

==================================================

Create a generic tool architecture.

Tools:

check_availability

book_appointment

cancel_appointment

reschedule_appointment

get_price

get_order_status

capture_lead

send_sms

send_whatsapp

transfer_to_human

create_callback

create_reservation

Each tool:

name

description

endpoint

authentication

input schema

output schema

timeout

failure message

enabled/disabled

Never allow the LLM to perform actions without a tool confirmation.

Example:

Agent:

"I can book that appointment for you."

Tool checks availability.

Only after successful response:

"Your appointment is confirmed."

==================================================

46. HUMAN HANDOFF

==================================================

Create human escalation settings.

Triggers:

Customer requests human

Agent confidence low

Emergency

Complaint

High-value lead

Payment issue

Custom rule

Actions:

Transfer call

Take callback request

Send notification

Create lead

Send SMS

Customer configures:

Transfer number

Fallback number

Business hours

After-hours behavior

==================================================

47. CALL ANALYTICS

==================================================

After each call generate:

summary

intent

outcome

lead score

customer name

requested service

appointment requested

follow-up required

sentiment if supported

language

duration

Store structured output.

Show in call detail.

==================================================

48. AGENT SAFETY

==================================================

Agent must:

Never invent information.

Never invent pricing.

Never invent availability.

Never claim an action happened unless backend confirms.

Never reveal system prompts.

Never reveal API keys.

Never provide medical/legal/financial professional advice beyond configured business information.

Escalate when uncertain.

Use business-specific rules.

==================================================

49. API COST ARCHITECTURE

==================================================

Implement internal usage metering.

For every interaction track:

tenant_id

call_id

stt_seconds

tts_characters

llm_input_tokens

llm_output_tokens

telephony_seconds

provider

estimated_cost

customer_billable_cost

Do not expose raw provider credentials.

Allow platform owner to configure:

Sarvam markup

Telephony markup

minimum balance

low-credit threshold

maximum call duration

monthly call limit

concurrency limit

==================================================

50. CRITICAL PRODUCT FLOW

==================================================

The most important flow must work end-to-end:

1. User signs up.

2. User pays.

3. Dashboard unlocks.

4. User selects "Dental Clinic".

5. User enters:

Business name:

Smile Dental

Description:

Dental clinic offering general and cosmetic dentistry.

Hours:

Mon-Sat 9AM-7PM

Services:

Cleaning ₹800

Root Canal ₹5000

Dental Implant ₹30000

Rules:

Do not provide diagnosis.

Always ask preferred appointment date.

Do not promise appointment availability without checking calendar.

Greeting:

"Thank you for calling Smile Dental. How may I help you?"

Language:

English + Hindi

Voice:

Simran

6. User clicks Save.

7. Backend validates data.

8. Backend generates agent configuration.

9. Sarvam integration is updated.

10. User clicks Test Agent.

11. User speaks:

"How much is a root canal?"

12. Agent answers using Smile Dental's configured information.

13. User buys/connects phone number.

14. User assigns phone number to agent.

15. Agent status becomes LIVE.

16. Someone calls the number.

17. Telephony routes call to voice runtime.

18. Sarvam STT understands caller.

19. Agent uses Smile Dental configuration.

20. Sarvam LLM generates answer.

21. Sarvam TTS speaks answer.

22. Call is stored.

23. Transcript is stored.

24. Summary is generated.

25. Lead is created if appropriate.

26. Customer sees the call inside Calls.

THIS IS THE CORE PRODUCT.

==================================================

51. DATABASE RLS

==================================================

Implement proper Supabase RLS.

Example:

Users can only SELECT businesses belonging to their organization.

Users can only SELECT calls where call.organization_id belongs to their organization.

Users cannot directly modify:

provider credentials

usage calculations

subscription status

agent deployment status

call duration

provider costs

Those must be server-controlled.

==================================================

52. SECRET MANAGEMENT

==================================================

Never store:

SARVAM_API_KEY

in frontend.

Use server-side secret:

SARVAM_API_KEY

Also:

RAZORPAY_KEY_SECRET

TELEPHONY_PROVIDER_SECRET

DATABASE_SERVICE_ROLE_KEY

Never expose service role keys.

==================================================

53. DEMO DATA

==================================================

For initial UI development, use a clearly marked demo workspace.

Demo:

Smile Dental

Use realistic data.

But clearly separate demo data from production data.

Once a real customer logs in, do not show Smile Dental demo data.

==================================================

54. RESPONSIVENESS

==================================================

Desktop:

Sidebar 250px

Main content fluid

Tablet:

Collapsible sidebar

Mobile:

Bottom navigation or hamburger menu.

Forms should work properly on mobile.

==================================================

55. COMPONENT ARCHITECTURE

==================================================

Reusable components:

Sidebar

Topbar

PageHeader

DataTable

SearchBar

FilterButton

StatusBadge

AgentStatus

VoiceCard

BusinessForm

ServiceEditor

FAQEditor

RuleEditor

PhoneNumberCard

CallRow

CallDetail

LeadRow

LeadDetail

ReservationCard

EmptyState

ErrorState

LoadingState

ConfirmDialog

UsageCard

CreditMeter

IntegrationCard

AgentTestConsole

==================================================

56. DO NOT BUILD

==================================================

Do NOT build:

fake AI training

fake "model training" progress bars

fake call logs

fake phone numbers

fake Sarvam API responses

fake payment success

fake agent deployment

fake telephony connection

fake analytics

If backend isn't connected:

show:

"Integration not connected"

rather than fake success.

==================================================

57. IMPLEMENTATION ORDER

==================================================

Build in this order:

PHASE 1

Authentication

Multi-tenancy

Database

RLS

PHASE 2

Subscription/payment

Onboarding

Business profile

Business types

PHASE 3

Services

FAQs

Rules

Business hours

PHASE 4

AI Receptionist configuration

Agent config generation

Versioning

PHASE 5

Sarvam integration

PHASE 6

Voice configuration

Agent testing

PHASE 7

Phone numbers

Telephony integration

PHASE 8

Inbound calls

Call logs

Transcripts

Recordings

Summaries

PHASE 9

Leads

Customers

Reservations

PHASE 10

Outbound campaigns

PHASE 11

Billing

Usage

Credits

PHASE 12

Analytics

Notifications

Settings

==================================================

58. FINAL REQUIREMENT

==================================================

The application must behave like a real SaaS product, not a UI mockup.

Every customer gets:

their own account

their own business

their own AI agent configuration

their own phone number(s)

their own calls

their own customers

their own leads

their own reservations

their own usage

their own billing

The platform owner provides the infrastructure.

The CUSTOMER controls the AI receptionist through structured business information.

The customer should never have to manually write prompts or understand how Sarvam works.

The customer's business information is transformed by our backend into the runtime configuration/context used by the Sarvam-powered voice agent.

The architecture must make it possible to add more AI providers later without rewriting the entire application.

Use a provider abstraction:

AIProvider

TelephonyProvider

PaymentProvider

KnowledgeProvider

Sarvam is the first AI provider.

==================================================

59. IMPORTANT SARVAM IMPLEMENTATION NOTE

==================================================

Use the current Sarvam APIs/documentation rather than inventing endpoints.

Sarvam currently provides:

Saaras v3 for speech recognition

Bulbul v3 for TTS

Sarvam 105B Conversations for conversational workloads

Voice Agents for agent deployment

telephony connections and phone-number management

agent variables

API tools

realtime voice capabilities

For live phone conversations, prefer the realtime/streaming architecture.

The Sarvam API key belongs ONLY to the server/platform.

If using Sarvam Voice Agents as the runtime, build an adapter around the supported Voice Agents/deployment APIs.

If using a custom runtime, implement the realtime voice loop with telephony + Sarvam APIs.

Do not claim an endpoint exists unless it is actually supported by the current Sarvam API.

==================================================

60. VISUAL GOAL

==================================================

The visual language should take inspiration from the supplied dashboard screenshots:

- dark SaaS interface

- left sidebar

- compact top bar

- high information density

- professional tables

- cards

- filters

- status badges

- detailed AI receptionist settings

- phone/agent status

- business configuration forms

But DO NOT copy branding, logos, exact text, or proprietary visual assets.

Create our own design system.

The finished product should look like a serious SaaS company that sells AI phone employees to businesses.

Most importantly:

THE CUSTOMER IS THE BUSINESS OWNER.

THEIR DASHBOARD IS THEIR CONTROL PANEL.

THE BUSINESS INFORMATION THEY ENTER IS THE SOURCE OF TRUTH FOR THEIR AI AGENT.

THE AGENT THEN ANSWERS REAL CUSTOMERS ON THEIR PHONE NUMBER.

```

### The actual architecture you want

The important part Lovable can easily get wrong is the **separation between your dashboard and Sarvam**.

It should be:

```text

                    YOUR SaaS

                       │

              ┌────────▼────────┐

              │ Customer Login  │

              └────────┬────────┘

                       │

              ┌────────▼────────┐

              │ Business Setup │

              │ Services       │

              │ FAQs           │

              │ Rules          │

              │ Hours          │

              │ Voice          │

              └────────┬────────┘

                       │

                       ▼

             ┌──────────────────┐

             │ YOUR BACKEND     │

             │ Agent Config     │

             │ Tenant Data      │

             │ Versioning       │

             │ Usage Metering   │

             └────────┬─────────┘

                      │

                SARVAM API KEY

                      │

                      ▼

             ┌──────────────────┐

             │ SARVAM AI        │

             │                  │

             │ LLM              │

             │ STT              │

             │ TTS              │

             │ Voice Runtime*   │

             └────────┬─────────┘

                      │

                      ▼

             ┌──────────────────┐

             │ TELEPHONY        │

             │                  │

             │ Exotel/Twilio/   │

             │ Sarvam number/   │

             │ other provider   │

             └────────┬─────────┘

                      │

                      ▼

                 CUSTOMER CALLS

```

The `*` matters. Sarvam now has a **Voice Agents platform** that can handle agent building/deployment and telephony, including renting numbers or connecting providers. ([Sarvam AI Developer Documentation][2])

So you have **two possible implementations**:

### Option A — Sarvam Voice Agents as the runtime

Your system creates/manages the customer's agent configuration and deployment in Sarvam.

This is the route I'd investigate first because Sarvam already has agent runtime + telephony + deployment concepts.

### Option B — Your own voice runtime

Your backend controls the call loop:

**Telephony → realtime STT → Sarvam conversational model → tools/knowledge → streaming TTS → telephony.**

Sarvam explicitly documents this architecture with telephony providers such as Twilio and Exotel. ([Sarvam AI Developer Documentation][3])

For your product, **don't start by building Option B unless Sarvam's Voice Agents APIs don't give you enough programmatic control.** Otherwise you're unnecessarily rebuilding a voice-agent platform.

---

## One more critical thing: don't let Lovable expose your Sarvam key

Your architecture should be:

```text

Browser

   ↓

Your backend

   ↓

SARVAM_API_KEY

   ↓

Sarvam

```

**NOT:**

```text

Browser

   ↓

SARVAM_API_KEY

   ↓

Sarvam

```

Sarvam's own developer docs explicitly require an API key and recommend keeping it secure/server-side. ([Sarvam AI Developer Documentation][4])

And the current Sarvam pricing makes this especially important for your billing architecture: STT is currently ₹30/hour, Bulbul v3 TTS is ₹30/10k characters, and Sarvam 105B/105B Conversations are token-priced. ([Sarvam AI Developer Documentation][5])

So **your customer should never see "Sarvam API cost."** Your backend should meter provider usage and charge your own SaaS price.

Also, Bulbul v3 currently has 30+ voices and supports the Indian-language set in the docs, with pace control from 0.5× to 2.0×. ([Sarvam AI Developer Documentation][6])

The biggest architectural mistake would be building a beautiful dashboard first and only afterward trying to figure out how to make the customer's saved information reach the actual phone agent. **The agent-configuration pipeline needs to be designed first, because that is the product.**

[1]: https://docs.sarvam.ai/conversations/overview?utm_source=chatgpt.com "Overview | Sarvam API Docs"

[2]: https://docs.sarvam.ai/conversations/deploy/telephony?utm_source=chatgpt.com "Phone Numbers | Sarvam API Docs"

[3]: https://docs.sarvam.ai/api/integration/build-voice-agent-with-twilio?utm_source=chatgpt.com "Build a Voice Agent or WhatsApp Bot using Twilio | Sarvam API Docs"

[4]: https://docs.sarvam.ai/api/getting-started/quickstart?utm_source=chatgpt.com "Developer Quickstart | Sarvam API Docs"

[5]: https://docs.sarvam.ai/api/getting-started/pricing?utm_source=chatgpt.com "Pricing | Sarvam API Docs"

[6]: https://docs.sarvam.ai/api/getting-started/models/bulbul?utm_source=chatgpt.com "Bulbul | Sarvam API Docs"

This is api key sk_ojd2cojj_dsn0akg1s7SukXh0p0cJSEG4 and make sure u store it in backend

make sure u build like with premuim uiux, it must not look like ai generated

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/7fe356e3-1302-493a-9e69-2127aeb6dcf6).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
