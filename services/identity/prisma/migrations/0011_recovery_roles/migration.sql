-- ADR-060 : rôles du Recouvrement (RECOVERY_ROLES dans src/domain/role/role.ts). Superviseur et
-- juriste au back-office, avec double authentification ; huissier et avocat partenaires, sans accès
-- au back-office ni double authentification : ils ne voient que leurs dossiers assignés.
INSERT INTO "roles" ("id", "service", "code", "scope_type", "requires_mfa", "backoffice_access", "description") VALUES
    ('019a0000-0000-7000-8000-000000000009', 'recovery', 'recovery_supervisor', 'domain', true, true, 'Superviseur du recouvrement'),
    ('019a0000-0000-7000-8000-00000000000a', 'recovery', 'legal_officer', 'domain', true, true, 'Juriste du recouvrement'),
    ('019a0000-0000-7000-8000-00000000000b', 'recovery', 'recovery_bailiff', 'domain', false, false, 'Huissier de justice partenaire du recouvrement'),
    ('019a0000-0000-7000-8000-00000000000c', 'recovery', 'recovery_lawyer', 'domain', false, false, 'Avocat partenaire du recouvrement')
ON CONFLICT DO NOTHING;
