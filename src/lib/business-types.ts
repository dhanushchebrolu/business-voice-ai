export type BusinessTypeId =
  | "dental_clinic"
  | "medical_clinic"
  | "hotel"
  | "restaurant"
  | "real_estate"
  | "salon"
  | "gym"
  | "education"
  | "travel"
  | "automotive"
  | "legal"
  | "home_services"
  | "retail"
  | "ecommerce"
  | "other";

export interface BusinessTypeDef {
  id: BusinessTypeId;
  label: string;
  blurb: string;
  /** What a "service" row is called for this vertical */
  itemLabel: string;
  itemLabelPlural: string;
  /** What an end customer is called */
  customerLabel: string;
  /** Extra per-item fields, stored in services.attributes */
  itemFields: { key: string; label: string; placeholder?: string }[];
  suggestedFaqs: { question: string; answer: string }[];
  suggestedRules: string[];
  usesReservations: boolean;
}

export const BUSINESS_TYPES: BusinessTypeDef[] = [
  {
    id: "dental_clinic",
    label: "Dental Clinic",
    blurb: "Appointments, treatments and pricing",
    itemLabel: "Treatment",
    itemLabelPlural: "Treatments",
    customerLabel: "Patients",
    itemFields: [
      { key: "doctor", label: "Doctor", placeholder: "Dr. Meera Rao" },
      { key: "preparation", label: "Preparation instructions", placeholder: "Avoid eating 2 hours before" },
    ],
    suggestedFaqs: [
      { question: "Do you accept walk-ins?", answer: "We prefer appointments, but we keep two walk-in slots each day." },
      { question: "Do you offer EMI or insurance?", answer: "We accept cashless insurance from major providers and offer 3-month EMI." },
    ],
    suggestedRules: [
      "Never provide a medical diagnosis over the phone.",
      "Always ask for the caller's preferred appointment date and time.",
      "Transfer dental emergencies to the on-call staff number immediately.",
    ],
    usesReservations: true,
  },
  {
    id: "medical_clinic",
    label: "Medical Clinic",
    blurb: "Consultations, doctors and schedules",
    itemLabel: "Consultation",
    itemLabelPlural: "Consultations",
    customerLabel: "Patients",
    itemFields: [
      { key: "doctor", label: "Doctor", placeholder: "Dr. Anil Kumar" },
      { key: "specialty", label: "Specialty", placeholder: "General medicine" },
    ],
    suggestedFaqs: [
      { question: "What are your consultation charges?", answer: "First consultation is charged at the listed rate; follow-ups within 7 days are free." },
    ],
    suggestedRules: [
      "Never provide a medical diagnosis or prescribe medication.",
      "Escalate any caller describing an emergency to a human immediately.",
    ],
    usesReservations: true,
  },
  {
    id: "hotel",
    label: "Hotel",
    blurb: "Rooms, rates and reservations",
    itemLabel: "Room type",
    itemLabelPlural: "Room types",
    customerLabel: "Guests",
    itemFields: [
      { key: "capacity", label: "Max occupancy", placeholder: "2 adults + 1 child" },
      { key: "amenities", label: "Amenities", placeholder: "AC, breakfast, balcony" },
    ],
    suggestedFaqs: [
      { question: "What are your check-in and check-out times?", answer: "Check-in is from 2:00 PM and check-out is by 11:00 AM." },
      { question: "Is breakfast included?", answer: "Breakfast is included with all room types." },
    ],
    suggestedRules: [
      "Never confirm a room booking without checking availability first.",
      "Always state the cancellation policy before confirming a reservation.",
    ],
    usesReservations: true,
  },
  {
    id: "restaurant",
    label: "Restaurant",
    blurb: "Menu, reservations and takeaway",
    itemLabel: "Dish",
    itemLabelPlural: "Menu items",
    customerLabel: "Guests",
    itemFields: [
      { key: "dietary", label: "Dietary tags", placeholder: "Veg, Jain, contains nuts" },
      { key: "portion", label: "Portion", placeholder: "Serves 2" },
    ],
    suggestedFaqs: [
      { question: "Do you deliver?", answer: "We deliver within a 5 km radius; delivery takes about 40 minutes." },
    ],
    suggestedRules: [
      "Never promise a table without confirming seating availability.",
      "Always ask for party size and preferred time for reservations.",
    ],
    usesReservations: true,
  },
  {
    id: "real_estate",
    label: "Real Estate",
    blurb: "Listings, site visits and leads",
    itemLabel: "Property",
    itemLabelPlural: "Properties",
    customerLabel: "Clients",
    itemFields: [
      { key: "location", label: "Location", placeholder: "Gachibowli, Hyderabad" },
      { key: "configuration", label: "Configuration", placeholder: "3 BHK, 1750 sq ft" },
    ],
    suggestedFaqs: [
      { question: "Can I schedule a site visit?", answer: "Yes, site visits run daily between 10 AM and 6 PM." },
    ],
    suggestedRules: [
      "Never quote a price outside the listed range without human approval.",
      "Always capture the caller's name, phone number and budget.",
    ],
    usesReservations: true,
  },
  {
    id: "salon",
    label: "Salon & Spa",
    blurb: "Stylists, services and slots",
    itemLabel: "Service",
    itemLabelPlural: "Services",
    customerLabel: "Clients",
    itemFields: [{ key: "stylist", label: "Stylist", placeholder: "Any available" }],
    suggestedFaqs: [{ question: "Do I need an appointment?", answer: "Walk-ins are welcome, but appointments get priority." }],
    suggestedRules: ["Always confirm the stylist and time before booking."],
    usesReservations: true,
  },
  {
    id: "gym",
    label: "Gym & Fitness",
    blurb: "Memberships, classes and trials",
    itemLabel: "Plan",
    itemLabelPlural: "Plans",
    customerLabel: "Members",
    itemFields: [{ key: "term", label: "Term", placeholder: "3 months" }],
    suggestedFaqs: [{ question: "Do you offer a free trial?", answer: "Yes, one free trial session per person." }],
    suggestedRules: ["Never offer discounts that are not listed in the plans."],
    usesReservations: true,
  },
  {
    id: "education",
    label: "Education",
    blurb: "Courses, batches and admissions",
    itemLabel: "Course",
    itemLabelPlural: "Courses",
    customerLabel: "Students",
    itemFields: [{ key: "batch", label: "Batch timing", placeholder: "Mon/Wed/Fri 6 PM" }],
    suggestedFaqs: [{ question: "When does the next batch start?", answer: "New batches start on the first Monday of every month." }],
    suggestedRules: ["Always capture the student's name, course interest and phone number."],
    usesReservations: false,
  },
  {
    id: "travel",
    label: "Travel Agency",
    blurb: "Packages, itineraries and quotes",
    itemLabel: "Package",
    itemLabelPlural: "Packages",
    customerLabel: "Travellers",
    itemFields: [{ key: "duration", label: "Duration", placeholder: "5 nights / 6 days" }],
    suggestedFaqs: [{ question: "Are flights included?", answer: "Flights are quoted separately based on the travel date." }],
    suggestedRules: ["Never confirm fares; fares change daily and must be quoted by a human."],
    usesReservations: false,
  },
  {
    id: "automotive",
    label: "Automotive",
    blurb: "Vehicles, service and test drives",
    itemLabel: "Model / service",
    itemLabelPlural: "Models & services",
    customerLabel: "Customers",
    itemFields: [{ key: "variant", label: "Variant", placeholder: "Petrol / AT" }],
    suggestedFaqs: [{ question: "Can I book a test drive?", answer: "Yes, test drives are available at the showroom daily." }],
    suggestedRules: ["Never commit to on-road pricing or delivery timelines."],
    usesReservations: true,
  },
  {
    id: "legal",
    label: "Legal Practice",
    blurb: "Practice areas and consultations",
    itemLabel: "Practice area",
    itemLabelPlural: "Practice areas",
    customerLabel: "Clients",
    itemFields: [{ key: "counsel", label: "Counsel", placeholder: "Adv. S. Rao" }],
    suggestedFaqs: [{ question: "What is the consultation fee?", answer: "The first consultation is 30 minutes at the listed fee." }],
    suggestedRules: [
      "Never give legal advice or an opinion on a case.",
      "Only collect the caller's contact details and the nature of the matter.",
    ],
    usesReservations: true,
  },
  {
    id: "home_services",
    label: "Home Services",
    blurb: "Jobs, visits and quotes",
    itemLabel: "Service",
    itemLabelPlural: "Services",
    customerLabel: "Customers",
    itemFields: [{ key: "visit_charge", label: "Visit charge", placeholder: "₹199, waived on booking" }],
    suggestedFaqs: [{ question: "How soon can a technician visit?", answer: "Usually the same day for calls before 3 PM." }],
    suggestedRules: ["Always capture the full service address and preferred slot."],
    usesReservations: true,
  },
  {
    id: "retail",
    label: "Retail Store",
    blurb: "Stock, pricing and store info",
    itemLabel: "Product",
    itemLabelPlural: "Products",
    customerLabel: "Customers",
    itemFields: [{ key: "brand", label: "Brand", placeholder: "In-house" }],
    suggestedFaqs: [{ question: "Do you have parking?", answer: "Yes, free customer parking is available at the store." }],
    suggestedRules: ["Never confirm stock availability without checking with staff."],
    usesReservations: false,
  },
  {
    id: "ecommerce",
    label: "E-commerce",
    blurb: "Orders, returns and support",
    itemLabel: "Product",
    itemLabelPlural: "Products",
    customerLabel: "Customers",
    itemFields: [{ key: "sku", label: "SKU", placeholder: "VN-1042" }],
    suggestedFaqs: [{ question: "What is your return window?", answer: "Returns are accepted within 7 days of delivery." }],
    suggestedRules: ["Never share order details without verifying the order ID and phone number."],
    usesReservations: false,
  },
  {
    id: "other",
    label: "Other",
    blurb: "A general-purpose receptionist",
    itemLabel: "Service",
    itemLabelPlural: "Services",
    customerLabel: "Customers",
    itemFields: [],
    suggestedFaqs: [{ question: "What are your working hours?", answer: "Our hours are listed on this page and the assistant reads them from your schedule." }],
    suggestedRules: ["Never invent information that is not in the business profile."],
    usesReservations: false,
  },
];

export function getBusinessType(id: string | null | undefined): BusinessTypeDef {
  return BUSINESS_TYPES.find((t) => t.id === id) ?? BUSINESS_TYPES[BUSINESS_TYPES.length - 1]!;
}

export const OBJECTIVES: { id: string; label: string; description: string }[] = [
  { id: "answer_questions", label: "Answer questions", description: "Handle general questions about the business" },
  { id: "book_appointments", label: "Book appointments", description: "Collect date, time and contact details" },
  { id: "take_reservations", label: "Take reservations", description: "Tables, rooms or slots" },
  { id: "capture_leads", label: "Capture leads", description: "Record every enquiry as a lead" },
  { id: "provide_pricing", label: "Quote pricing", description: "Only from your configured price list" },
  { id: "handle_faqs", label: "Handle FAQs", description: "Answer from your FAQ list" },
  { id: "transfer_to_human", label: "Transfer to a human", description: "Escalate to your team" },
  { id: "take_messages", label: "Take messages", description: "Record callbacks after hours" },
];

export interface CapabilityDef {
  id: string;
  label: string;
  description: string;
  /** integration that must be connected before this can run on a live call */
  requires?: "telephony" | "calendar" | "whatsapp" | "sms" | "crm";
}

export const CAPABILITIES: CapabilityDef[] = [
  { id: "answer_faqs", label: "Answer FAQs", description: "Uses your FAQ list" },
  { id: "explain_services", label: "Explain services", description: "Uses your service catalogue" },
  { id: "quote_prices", label: "Quote prices", description: "Only prices you entered" },
  { id: "check_hours", label: "Check business hours", description: "Uses your weekly schedule" },
  { id: "capture_lead", label: "Capture lead", description: "Saves caller details to Leads" },
  { id: "collect_details", label: "Collect customer information", description: "Name, phone, requirement" },
  { id: "book_appointment", label: "Book appointments", description: "Needs a connected calendar", requires: "calendar" },
  { id: "cancel_appointment", label: "Cancel appointments", description: "Needs a connected calendar", requires: "calendar" },
  { id: "reschedule_appointment", label: "Reschedule appointments", description: "Needs a connected calendar", requires: "calendar" },
  { id: "check_availability", label: "Check availability", description: "Needs a connected calendar", requires: "calendar" },
  { id: "send_sms", label: "Send SMS confirmation", description: "Needs an SMS provider", requires: "sms" },
  { id: "send_whatsapp", label: "Send WhatsApp message", description: "Needs WhatsApp Business", requires: "whatsapp" },
  { id: "transfer_to_human", label: "Transfer to a human", description: "Needs a live phone connection", requires: "telephony" },
  { id: "take_callback", label: "Take callback request", description: "Saves a callback task" },
  { id: "create_ticket", label: "Create support ticket", description: "Needs a CRM connection", requires: "crm" },
];

export const PERSONAS = [
  { id: "professional", label: "Professional", hint: "Efficient, neutral, business-like" },
  { id: "friendly", label: "Friendly", hint: "Warm and conversational" },
  { id: "warm", label: "Warm", hint: "Caring, reassuring, unhurried" },
  { id: "concise", label: "Concise", hint: "Short answers, minimal small talk" },
  { id: "formal", label: "Formal", hint: "Polite and deferential" },
  { id: "casual", label: "Casual", hint: "Relaxed and informal" },
];

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
