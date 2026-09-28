-- Remocao definitiva do fluxo de autenticacao por email + OTP.
--
-- Contexto: o envio de email dependia de dominio verificada e de chave de API
-- (Resend) que nunca existiram em producao — o email nunca foi entregue a um
-- cliente real. O login/cadastro por codigo + senha (auth_login /
-- register_business) ja cobre o mesmo publico e recebe o segredo do usuario
-- (PIN, hashed, com lockout por tentativas). Decisao completa em
-- SECURITY-DECISIONS.md.
--
-- Nenhuma outra funcao chama estas duas; o DROP nao tem dependentes. Se o
-- email voltar um dia, auth-login-by-email.sql e register-business-by-email.sql
-- recriam o fluxo.

DROP FUNCTION IF EXISTS public.auth_login_by_email(text, text);

DROP FUNCTION IF EXISTS public.register_business_by_email(
  text, text, text, text, text, text, text, text, text,
  double precision, double precision, text, text
);