/** First-boot Feishu app registration through the official QR flow. */
export interface LarkCredentials {
    readonly appId: string;
    readonly appSecret: string;
}
export interface OnboardedApp extends LarkCredentials {
    readonly registeredBy?: string;
}
interface RegistrationPreset {
    readonly name: string;
    readonly desc: string;
}
interface RegistrationCode {
    readonly url: string;
    readonly expireIn: number;
}
export interface RegisterAppRequest {
    readonly source: string;
    readonly appId?: string;
    readonly appPreset: RegistrationPreset;
    readonly signal: AbortSignal;
    readonly onQRCodeReady: (code: RegistrationCode) => void;
}
interface RegistrationResult {
    readonly client_id: string;
    readonly client_secret: string;
    readonly user_info?: {
        readonly open_id?: string;
    };
}
export type RegisterAppPort = (request: RegisterAppRequest) => Promise<RegistrationResult>;
export interface OnboardingOptions {
    readonly register: RegisterAppPort;
    readonly notify: (line: string) => void;
    readonly persist: (app: OnboardedApp) => Promise<boolean>;
    readonly onCredentials: (app: OnboardedApp) => void;
    readonly appId?: string;
    readonly reissueFloorMs?: number;
}
/** Lifecycle handle owned by the runtime fiber. */
export interface OnboardingFlow {
    readonly completed: Promise<void>;
    close(): void;
}
/** Start registration and return an explicit cancellation boundary. */
export declare function startOnboarding(options: OnboardingOptions): OnboardingFlow;
export {};
//# sourceMappingURL=onboarding.d.ts.map