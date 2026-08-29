export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_configs: {
        Row: {
          active_version: number
          advanced_mode: boolean
          after_hours_behavior: string
          agent_name: string
          business_id: string
          capabilities: Json
          created_at: string
          custom_personality: string | null
          extra_languages: string[]
          greetings: Json
          id: string
          multilingual: boolean
          objectives: string[]
          organization_id: string
          persona: string
          primary_language: string
          speaking_pace: number
          status: string
          transfer_number: string | null
          updated_at: string
          voice_id: string
        }
        Insert: {
          active_version?: number
          advanced_mode?: boolean
          after_hours_behavior?: string
          agent_name?: string
          business_id: string
          capabilities?: Json
          created_at?: string
          custom_personality?: string | null
          extra_languages?: string[]
          greetings?: Json
          id?: string
          multilingual?: boolean
          objectives?: string[]
          organization_id: string
          persona?: string
          primary_language?: string
          speaking_pace?: number
          status?: string
          transfer_number?: string | null
          updated_at?: string
          voice_id?: string
        }
        Update: {
          active_version?: number
          advanced_mode?: boolean
          after_hours_behavior?: string
          agent_name?: string
          business_id?: string
          capabilities?: Json
          created_at?: string
          custom_personality?: string | null
          extra_languages?: string[]
          greetings?: Json
          id?: string
          multilingual?: boolean
          objectives?: string[]
          organization_id?: string
          persona?: string
          primary_language?: string
          speaking_pace?: number
          status?: string
          transfer_number?: string | null
          updated_at?: string
          voice_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_configs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_versions: {
        Row: {
          business_id: string
          change_note: string | null
          created_at: string
          created_by: string | null
          id: string
          instructions: string
          organization_id: string
          snapshot: Json
          status: string
          version: number
        }
        Insert: {
          business_id: string
          change_note?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          instructions: string
          organization_id: string
          snapshot: Json
          status?: string
          version: number
        }
        Update: {
          business_id?: string
          change_note?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          instructions?: string
          organization_id?: string
          snapshot?: Json
          status?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_versions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_versions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      business_hours: {
        Row: {
          business_id: string
          created_at: string
          day_of_week: number
          id: string
          intervals: Json
          is_closed: boolean
          organization_id: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          day_of_week: number
          id?: string
          intervals?: Json
          is_closed?: boolean
          organization_id: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          day_of_week?: number
          id?: string
          intervals?: Json
          is_closed?: boolean
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_hours_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_hours_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      business_rules: {
        Row: {
          business_id: string
          created_at: string
          id: string
          is_active: boolean
          organization_id: string
          priority: number
          rule: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          organization_id: string
          priority?: number
          rule: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          organization_id?: string
          priority?: number
          rule?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_rules_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          address: string | null
          business_type: string
          city: string | null
          country: string | null
          created_at: string
          currency: string
          description: string | null
          email: string | null
          facebook: string | null
          id: string
          instagram: string | null
          is_demo: boolean
          maps_url: string | null
          name: string
          organization_id: string
          postal_code: string | null
          primary_phone: string | null
          secondary_phone: string | null
          state: string | null
          timezone: string
          updated_at: string
          website: string | null
          whatsapp: string | null
        }
        Insert: {
          address?: string | null
          business_type?: string
          city?: string | null
          country?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          email?: string | null
          facebook?: string | null
          id?: string
          instagram?: string | null
          is_demo?: boolean
          maps_url?: string | null
          name: string
          organization_id: string
          postal_code?: string | null
          primary_phone?: string | null
          secondary_phone?: string | null
          state?: string | null
          timezone?: string
          updated_at?: string
          website?: string | null
          whatsapp?: string | null
        }
        Update: {
          address?: string | null
          business_type?: string
          city?: string | null
          country?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          email?: string | null
          facebook?: string | null
          id?: string
          instagram?: string | null
          is_demo?: boolean
          maps_url?: string | null
          name?: string
          organization_id?: string
          postal_code?: string | null
          primary_phone?: string | null
          secondary_phone?: string | null
          state?: string | null
          timezone?: string
          updated_at?: string
          website?: string | null
          whatsapp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "businesses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      call_logs: {
        Row: {
          agent_version: number | null
          business_id: string | null
          caller_name: string | null
          caller_number: string | null
          created_at: string
          direction: string
          duration_seconds: number
          ended_at: string | null
          id: string
          language: string | null
          lead_score: string | null
          organization_id: string
          outcome: string | null
          phone_number_id: string | null
          recording_url: string | null
          started_at: string
          status: string
          summary: string | null
          transcript: Json | null
        }
        Insert: {
          agent_version?: number | null
          business_id?: string | null
          caller_name?: string | null
          caller_number?: string | null
          created_at?: string
          direction?: string
          duration_seconds?: number
          ended_at?: string | null
          id?: string
          language?: string | null
          lead_score?: string | null
          organization_id: string
          outcome?: string | null
          phone_number_id?: string | null
          recording_url?: string | null
          started_at?: string
          status?: string
          summary?: string | null
          transcript?: Json | null
        }
        Update: {
          agent_version?: number | null
          business_id?: string | null
          caller_name?: string | null
          caller_number?: string | null
          created_at?: string
          direction?: string
          duration_seconds?: number
          ended_at?: string | null
          id?: string
          language?: string | null
          lead_score?: string | null
          organization_id?: string
          outcome?: string | null
          phone_number_id?: string | null
          recording_url?: string | null
          started_at?: string
          status?: string
          summary?: string | null
          transcript?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "call_logs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
        ]
      }
      faqs: {
        Row: {
          answer: string
          business_id: string
          category: string | null
          created_at: string
          id: string
          is_active: boolean
          organization_id: string
          question: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          answer: string
          business_id: string
          category?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          organization_id: string
          question: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          answer?: string
          business_id?: string
          category?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          organization_id?: string
          question?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "faqs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faqs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_documents: {
        Row: {
          business_id: string
          content: string | null
          created_at: string
          error: string | null
          id: string
          organization_id: string
          source_type: string
          source_url: string | null
          status: string
          storage_path: string | null
          title: string
          updated_at: string
        }
        Insert: {
          business_id: string
          content?: string | null
          created_at?: string
          error?: string | null
          id?: string
          organization_id: string
          source_type?: string
          source_url?: string | null
          status?: string
          storage_path?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          content?: string | null
          created_at?: string
          error?: string | null
          id?: string
          organization_id?: string
          source_type?: string
          source_url?: string | null
          status?: string
          storage_path?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_documents_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          asked_about: string | null
          business_id: string | null
          call_id: string | null
          created_at: string
          email: string | null
          id: string
          name: string | null
          notes: string | null
          organization_id: string
          phone: string | null
          score: string
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          asked_about?: string | null
          business_id?: string | null
          call_id?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          organization_id: string
          phone?: string | null
          score?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          asked_about?: string | null
          business_id?: string | null
          call_id?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          organization_id?: string
          phone?: string | null
          score?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "call_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          kind: string
          organization_id: string
          read_at: string | null
          title: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          organization_id: string
          read_at?: string | null
          title: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string
          read_at?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          id: string
          invited_email: string | null
          organization_id: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_email?: string | null
          organization_id: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_email?: string | null
          organization_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          country: string | null
          created_at: string
          currency: string
          id: string
          name: string
          onboarding_completed: boolean
          owner_id: string
          slug: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          country?: string | null
          created_at?: string
          currency?: string
          id?: string
          name: string
          onboarding_completed?: boolean
          owner_id: string
          slug?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          country?: string | null
          created_at?: string
          currency?: string
          id?: string
          name?: string
          onboarding_completed?: boolean
          owner_id?: string
          slug?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      phone_numbers: {
        Row: {
          business_id: string | null
          connection_id: string | null
          country: string
          created_at: string
          e164: string
          id: string
          inbound_enabled: boolean
          monthly_price: number | null
          organization_id: string
          outbound_enabled: boolean
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          connection_id?: string | null
          country?: string
          created_at?: string
          e164: string
          id?: string
          inbound_enabled?: boolean
          monthly_price?: number | null
          organization_id: string
          outbound_enabled?: boolean
          provider?: string
          status?: string
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          connection_id?: string | null
          country?: string
          created_at?: string
          e164?: string
          id?: string
          inbound_enabled?: boolean
          monthly_price?: number | null
          organization_id?: string
          outbound_enabled?: boolean
          provider?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phone_numbers_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "telephony_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phone_numbers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          country: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      services: {
        Row: {
          attributes: Json
          business_id: string
          category: string | null
          created_at: string
          currency: string
          description: string | null
          duration_minutes: number | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          organization_id: string
          price: number | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          attributes?: Json
          business_id: string
          category?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          duration_minutes?: number | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          organization_id: string
          price?: number | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          attributes?: Json
          business_id?: string
          category?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          duration_minutes?: number | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          organization_id?: string
          price?: number | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string
          current_period_end: string | null
          id: string
          organization_id: string
          plan: string
          provider: string | null
          provider_subscription_id: string | null
          status: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_period_end?: string | null
          id?: string
          organization_id: string
          plan?: string
          provider?: string | null
          provider_subscription_id?: string | null
          status?: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_period_end?: string | null
          id?: string
          organization_id?: string
          plan?: string
          provider?: string | null
          provider_subscription_id?: string | null
          status?: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      telephony_connections: {
        Row: {
          created_at: string
          id: string
          label: string | null
          last_checked_at: string | null
          last_error: string | null
          organization_id: string
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          last_checked_at?: string | null
          last_error?: string | null
          organization_id: string
          provider: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          last_checked_at?: string | null
          last_error?: string | null
          organization_id?: string
          provider?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telephony_connections_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_records: {
        Row: {
          billable_cost: number
          call_id: string | null
          id: string
          kind: string
          occurred_at: string
          organization_id: string
          provider: string
          provider_cost: number
          quantity: number
          unit: string
        }
        Insert: {
          billable_cost?: number
          call_id?: string | null
          id?: string
          kind: string
          occurred_at?: string
          organization_id: string
          provider?: string
          provider_cost?: number
          quantity?: number
          unit?: string
        }
        Update: {
          billable_cost?: number
          call_id?: string | null
          id?: string
          kind?: string
          occurred_at?: string
          organization_id?: string
          provider?: string
          provider_cost?: number
          quantity?: number
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_records_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "call_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_org_role: {
        Args: {
          _org: string
          _roles: Database["public"]["Enums"]["member_role"][]
        }
        Returns: boolean
      }
      is_org_member: { Args: { _org: string }; Returns: boolean }
    }
    Enums: {
      member_role: "owner" | "admin" | "manager" | "staff" | "viewer"
      subscription_status:
        | "trial"
        | "active"
        | "past_due"
        | "cancelled"
        | "expired"
        | "suspended"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      member_role: ["owner", "admin", "manager", "staff", "viewer"],
      subscription_status: [
        "trial",
        "active",
        "past_due",
        "cancelled",
        "expired",
        "suspended",
      ],
    },
  },
} as const
