import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class Me {
  @Field(() => ID) uid!: string;
  @Field() displayName!: string;
  @Field() phone!: string;
  @Field() email!: string;
  @Field(() => String, { nullable: true }) handle!: string | null;
  @Field(() => String, { nullable: true }) accountName!: string | null;
  @Field() viewOnly!: boolean;
  @Field() pilotAllowed!: boolean;
  @Field() merchant!: boolean;
  @Field(() => String, { nullable: true }) accountId!: string | null;
  @Field(() => String, { nullable: true }) accountStatus!: string | null;
}

@InputType()
export class CreateAccountInput {
  @Field() email!: string;
  @Field() password!: string;
  @Field() displayName!: string;
  @Field() turnstileToken!: string;
}

@InputType()
export class RegisterProfileInput {
  @Field() displayName!: string;
  @Field() phone!: string;
  @Field(() => String, { nullable: true }) handle?: string | null;
  @Field() accountName!: string;
}

@ObjectType()
export class HandleAvailability {
  @Field() handle!: string;
  @Field() available!: boolean;
  @Field(() => String, { nullable: true }) reason!: string | null;
  @Field(() => [String]) suggestions!: string[];
}

@ObjectType()
export class AccountNameAvailability {
  @Field() name!: string;
  @Field(() => String, { nullable: true }) accountId!: string | null;
  @Field() available!: boolean;
  @Field(() => String, { nullable: true }) reason!: string | null;
  @Field(() => [String]) suggestions!: string[];
}

@ObjectType()
export class Balance {
  @Field() domain!: string;
  @Field() currency!: string;
  @Field() posted!: string;
  @Field() held!: string;
  @Field() available!: string;
}

@ObjectType()
export class ActivityItem {
  @Field(() => ID) id!: string;
  @Field() domain!: string;
  @Field() kind!: string;
  @Field() direction!: string;
  @Field() status!: string;
  @Field() amount!: string;
  @Field() currency!: string;
  @Field() createdAt!: string;
  @Field(() => String, { nullable: true }) counterparty!: string | null;
  @Field(() => String, { nullable: true }) counterpartyName!: string | null;
  @Field(() => String, { nullable: true }) opId!: string | null;
  @Field(() => String, { nullable: true }) txHash!: string | null;
  @Field(() => String, { nullable: true }) explorerUrl!: string | null;
  @Field(() => String, { nullable: true }) sandboxId!: string | null;
}

@ObjectType()
export class PendingItem {
  @Field(() => ID) id!: string;
  @Field() kind!: string;
  @Field() status!: string;
  @Field() amount!: string;
  @Field() currency!: string;
  @Field(() => String, { nullable: true }) counterparty!: string | null;
  @Field() createdAt!: string;
}

@ObjectType()
export class OpView {
  @Field(() => ID) opId!: string;
  @Field() kind!: string;
  @Field() status!: string;
  @Field() receiver!: string;
  @Field() amount!: string;
  @Field(() => String, { nullable: true }) invoiceId!: string | null;
  @Field(() => [String]) txHashes!: string[];
  @Field(() => [String]) explorerUrls!: string[];
  @Field() createdAt!: string;
  @Field() updatedAt!: string;
}

@ObjectType()
export class Recipient {
  @Field() kind!: string;
  @Field() accountId!: string;
  @Field(() => String, { nullable: true }) displayName!: string | null;
  @Field(() => String, { nullable: true }) handle!: string | null;
  @Field() canReceive!: boolean;
}

@ObjectType()
export class SpendingLimit {
  @Field() currency!: string;
  @Field() dailyLimit!: string;
  @Field() spent24h!: string;
  @Field() remaining!: string;
  @Field() maxOpAmount!: string;
  @Field(() => String, { nullable: true }) pendingLimit!: string | null;
  @Field(() => String, { nullable: true }) pendingLimitEffectiveAt!: string | null;
  @Field(() => String, { nullable: true }) frozenUntil!: string | null;
  @Field(() => String, { nullable: true }) recoveryExecutableAt!: string | null;
}

@ObjectType()
export class AccountEvent {
  @Field() kind!: string;
  @Field() id!: string;
  @Field() status!: string;
}

@ObjectType()
export class DeviceResult {
  @Field() publicKey!: string;
  @Field() status!: string;
  @Field() provisioningQueued!: boolean;
}

@InputType()
export class PrepareTransferInput {
  @Field(() => String, { nullable: true }) toHandle?: string | null;
  @Field(() => String, { nullable: true }) toPhone?: string | null;
  @Field(() => String, { nullable: true }) toAccount?: string | null;
  @Field() amount!: string;
  @Field(() => String, { nullable: true }) requestId?: string | null;
}

@InputType()
export class CreateMoneyRequestInput {
  @Field() toHandle!: string;
  @Field() amount!: string;
  @Field(() => String, { nullable: true }) note?: string | null;
}

@ObjectType()
export class MoneyRequestView {
  @Field(() => ID) requestId!: string;
  @Field() direction!: string;
  @Field() counterpartyName!: string;
  @Field(() => String, { nullable: true }) counterpartyHandle!: string | null;
  @Field(() => String, { nullable: true }) counterpartyAccount!: string | null;
  @Field() amount!: string;
  @Field(() => String, { nullable: true }) note!: string | null;
  @Field() status!: string;
  @Field() paying!: boolean;
  @Field() createdAt!: string;
  @Field() updatedAt!: string;
  @Field() permission!: string;
  @Field(() => Int) earlierRequests!: number;
}

@ObjectType()
export class RequestContactView {
  @Field(() => ID) id!: string;
  @Field() kind!: string;
  @Field() name!: string;
  @Field(() => String, { nullable: true }) handle!: string | null;
  @Field() since!: string;
}

@ObjectType()
export class PreparedOp {
  @Field(() => ID) opId!: string;
  @Field() accountId!: string;
  @Field() methodName!: string;
  @Field() argsBase64!: string;
  @Field() deviceOpHash!: string;
  @Field() receiver!: string;
  @Field() amount!: string;
  @Field() expiresAtNs!: string;
}

@ObjectType()
export class SubmitResult {
  @Field(() => ID) opId!: string;
  @Field() status!: string;
  @Field() delegateHash!: string;
}

@InputType()
export class CreateInvoiceInput {
  @Field() amount!: string;
  @Field(() => Int) expiresInMinutes!: number;
  @Field(() => String, { nullable: true }) reference?: string | null;
}

@ObjectType()
export class CreatedInvoice {
  @Field(() => ID) invoiceId!: string;
  @Field() amount!: string;
  @Field(() => Int) feeBps!: number;
  @Field() expiresAtNs!: string;
  @Field() signature!: string;
  @Field() paymentUrl!: string;
}

@ObjectType()
export class MerchantInvoice {
  @Field(() => ID) invoiceId!: string;
  @Field() amount!: string;
  @Field(() => Int) feeBps!: number;
  @Field() expiresAtNs!: string;
  @Field(() => String, { nullable: true }) reference!: string | null;
  @Field() status!: string;
  @Field() paymentUrl!: string;
  @Field() createdAt!: string;
  @Field(() => String, { nullable: true }) payer!: string | null;
  @Field(() => String, { nullable: true }) fee!: string | null;
  @Field(() => String, { nullable: true }) net!: string | null;
  @Field(() => String, { nullable: true }) paidTxHash!: string | null;
  @Field(() => String, { nullable: true }) paidExplorerUrl!: string | null;
  @Field(() => String, { nullable: true }) paidAt!: string | null;
}

@ObjectType()
export class InvoiceView {
  @Field(() => ID) invoiceId!: string;
  @Field() merchantName!: string;
  @Field() merchantAccount!: string;
  @Field() token!: string;
  @Field() amount!: string;
  @Field(() => Int) feeBps!: number;
  @Field() expiresAtNs!: string;
  @Field() status!: string;
  @Field() paymentUrl!: string;
  @Field() crossChainEnabled!: boolean;
}

@ObjectType()
export class IndicativeRate {
  @Field() base!: string;
  @Field() quote!: string;
  @Field() rate!: string;
  @Field() source!: string;
  @Field() asOf!: string;
}
